/**
 * Pipeline Worker
 * Runs the full TestBot pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');

// Load environment variables from multiple paths
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) break;
}

const AutoDetector = require('./auto-detector');
const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const JiraClient = require('./jira/client');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const AgentContextRequester = require('./agent-context-requester');

const log = (msg) => process.stderr.write(`[Testbot Worker] ${msg}\n`);

/**
 * Write status update to disk so the caller can track progress.
 */
function updateStatus(statusDir, phase, data) {
  try {
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        phase,
        timestamp: new Date().toISOString(),
        ...data,
      }, null, 2)
    );
  } catch (e) {
    log(`Failed to write status: ${e.message}`);
  }
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'testbot-reports', '.runs', runId);
  fs.mkdirSync(statusDir, { recursive: true });

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Pipeline started',
    project: config.projectName,
  });

  try {
    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled) {
      updateStatus(statusDir, 'jira', { runId, message: 'Fetching Jira stories...' });
      log('Fetching Jira stories...');
      const jiraClient = new JiraClient(config.jira);
      jiraStories = await jiraClient.fetchActiveStories();
      log(`Found ${jiraStories.length} active stories`);
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', { runId, message: 'Gathering codebase context...' });
      log('Gathering codebase context automatically...');
      const contextGatherer = new ContextGatherer({
        projectPath: config.projectPath,
        language: config.language,
      });
      codebaseContext = await contextGatherer.gatherRichContext();
      log(`Found ${codebaseContext.pages?.length || 0} pages, ${codebaseContext.apiEndpoints?.length || 0} API endpoints`);
    }

    // -------------------------------------------------------
    // 3. Read PRD file if specified
    // -------------------------------------------------------
    let prdContent = null;
    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        log(`Read PRD file: ${config.prdFile}`);
      } catch (error) {
        log(`Could not read PRD file: ${error.message}`);
      }
    }

    // -------------------------------------------------------
    // 4. Generate tests (ALWAYS when generateTests=true)
    // -------------------------------------------------------
    if (config.generateTests) {
      updateStatus(statusDir, 'generating', { runId, message: 'Generating tests...' });
      log('Generating tests...');

      // Always generate via template-based generation
      const playwrightMCP = new PlaywrightMCPClient(config);
      const generationResult = await playwrightMCP.generateTests({
        context: codebaseContext || { pages: [], apiEndpoints: [], workflows: [] },
        testType: config.testType,
        projectPath: config.projectPath,
        prdFile: config.prdFile,
      });
      log(`Generated ${generationResult.generated} test files via templates`);

      // Also try SaaS backend if API key is set
      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
      if (testbotApiKey && codebaseContext) {
        log('Also generating tests via TestBot backend...');
        try {
          const fetch = require('node-fetch');
          const genResponse = await fetch(`${dashboardUrl}/api/generate-tests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: testbotApiKey,
              context: codebaseContext,
              testType: config.testType,
              prd: prdContent || '',
              projectInfo: {
                name: config.projectName,
                framework: codebaseContext?.projectStructure?.framework || 'Unknown',
                baseURL: config.baseURL,
              },
            }),
          });

          if (genResponse.ok) {
            const genData = await genResponse.json();
            const generatedTests = genData.tests || [];
            log(`Received ${generatedTests.length} test file(s) from TestBot backend`);

            const testsDir = path.join(config.projectPath, 'tests', 'generated');
            if (!fs.existsSync(testsDir)) {
              fs.mkdirSync(testsDir, { recursive: true });
            }
            for (const test of generatedTests) {
              const filePath = path.join(testsDir, test.filename);
              fs.writeFileSync(filePath, test.content, 'utf-8');
              log(`  Wrote: ${test.filename} (${test.type})`);
            }
          } else {
            log(`TestBot backend generation failed: HTTP ${genResponse.status}`);
          }
        } catch (e) {
          log(`TestBot backend generation error: ${e.message}`);
        }
      }

      // Generate from Jira stories if available
      if (jiraStories && jiraStories.length > 0) {
        log('Generating tests from Jira stories...');
        const playwright = new PlaywrightIntegration(config);
        await playwright.generateTests({
          prdFile: config.prdFile,
          jiraStories,
          testType: config.testType,
        });
      }
    }

    // -------------------------------------------------------
    // 5. Run tests
    // -------------------------------------------------------
    updateStatus(statusDir, 'running', { runId, message: 'Running Playwright tests...' });
    log('Running tests...');

    const playwright = new PlaywrightIntegration(config);

    const mcpParallelEnabled = process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
                                process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    let testResults;

    if (mcpParallelEnabled) {
      log('Parallel execution enabled - running TestBot + Playwright MCP...');
      const playwrightMCPIntegration = new PlaywrightMCPIntegration({
        projectPath: config.projectPath,
        baseURL: config.baseURL,
      });

      const [directResults, mcpResults] = await Promise.all([
        playwright.runTests(),
        playwrightMCPIntegration.runTests()
      ]);

      log(`Direct execution: ${directResults.total} tests`);
      log(`MCP execution: ${mcpResults.available !== false ? mcpResults.total : 'unavailable'} tests`);

      const merger = new ResultsMerger({ projectPath: config.projectPath });
      testResults = merger.mergeResults(directResults, mcpResults);
    } else {
      testResults = await playwright.runTests();
    }

    log(`Tests completed: ${testResults.total} total, ${testResults.passed} passed, ${testResults.failed} failed`);

    updateStatus(statusDir, 'tests_complete', {
      runId,
      message: `Tests completed: ${testResults.passed}/${testResults.total} passed`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: testResults.duration,
      },
    });

    // -------------------------------------------------------
    // 6. Generate report
    // -------------------------------------------------------
    updateStatus(statusDir, 'reporting', { runId, message: 'Generating report...' });
    log('Generating report...');

    const reportGen = new ReportGenerator();
    const testbotApiKey = process.env.TESTBOT_API_KEY;
    const testbotDashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';

    if (testbotApiKey) {
      log(`Dashboard sync enabled — will post results to ${testbotDashboardUrl}`);
    } else {
      log('TESTBOT_API_KEY not set — skipping web dashboard sync');
    }

    const report = await reportGen.generate({
      projectPath: config.projectPath,
      projectName: config.projectName,
      testResults,
      aiAnalysis: null,
      jiraData: jiraStories,
      api_key: testbotApiKey,
      dashboard_url: testbotDashboardUrl,
    });

    // -------------------------------------------------------
    // 7. Open dashboard
    // -------------------------------------------------------
    let dashboardUrl = null;
    if (config.openDashboard) {
      log('Opening dashboard...');
      try {
        dashboardUrl = await DashboardLauncher.open(report.path);
      } catch (e) {
        log(`Dashboard open failed: ${e.message}`);
        dashboardUrl = report.url || `file://${report.path}`;
      }
    }

    // -------------------------------------------------------
    // 8. Final status
    // -------------------------------------------------------
    const passRate = testResults.total > 0
      ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
      : '0%';

    updateStatus(statusDir, 'completed', {
      runId,
      message: `Pipeline complete — ${passRate} pass rate`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: `${testResults.duration}ms`,
        passRate,
      },
      reportPath: report.path,
      dashboardUrl: dashboardUrl || report.url,
    });

    log(`Pipeline complete. Report: ${report.path}`);
    log(`Dashboard: ${dashboardUrl || report.url}`);

  } catch (error) {
    log(`Pipeline error: ${error.message}`);
    log(error.stack);

    updateStatus(statusDir, 'error', {
      runId,
      message: `Pipeline failed: ${error.message}`,
      error: error.message,
      stack: error.stack,
    });
  }
}

// -------------------------------------------------------
// Entry point: receive config via IPC from parent
// -------------------------------------------------------
process.on('message', (msg) => {
  const { config, runId } = msg;

  // Disconnect IPC so parent is free
  try { process.disconnect(); } catch (e) { /* already disconnected */ }

  // Run pipeline
  runPipeline(config, runId)
    .then(() => process.exit(0))
    .catch((err) => {
      log(`Fatal error: ${err.message}`);
      process.exit(1);
    });
});
