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
const Logger = require('./logger');

// Initialize logger for the worker process
Logger.initialize();

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
    Logger.error('PipelineWorker', `Failed to write status`, e);
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
  Logger.info('PipelineWorker', `Pipeline started`, { runId, project: config.projectName });

  try {
    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled) {
      updateStatus(statusDir, 'jira', { runId, message: 'Fetching Jira stories...' });
      Logger.info('PipelineWorker', 'Fetching Jira stories...');
      const jiraClient = new JiraClient(config.jira);
      jiraStories = await jiraClient.fetchActiveStories();
      Logger.info('PipelineWorker', `Found ${jiraStories.length} active stories`);
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', { runId, message: 'Gathering codebase context...' });
      Logger.info('PipelineWorker', 'Gathering codebase context automatically...');
      const contextGatherer = new ContextGatherer({
        projectPath: config.projectPath,
        language: config.language,
      });
      codebaseContext = await contextGatherer.gatherRichContext();
      Logger.info('PipelineWorker', `Codebase context gathered`, {
        pages: codebaseContext.pages?.length || 0,
        endpoints: codebaseContext.apiEndpoints?.length || 0
      });
    }

    // -------------------------------------------------------
    // 3. Read PRD file if specified
    // -------------------------------------------------------
    let prdContent = null;
    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        Logger.info('PipelineWorker', `Read PRD file`, { path: config.prdFile });
      } catch (error) {
        Logger.error('PipelineWorker', `Could not read PRD file`, error);
      }
    }

    // -------------------------------------------------------
    // 4. Generate tests (ALWAYS when generateTests=true)
    // -------------------------------------------------------
    if (config.generateTests) {
      updateStatus(statusDir, 'generating', { runId, message: 'Generating tests...' });
      Logger.info('PipelineWorker', 'Generating tests via PlaywrightMCPClient...');

      // Always generate via template-based generation
      const playwrightMCP = new PlaywrightMCPClient(config);
      const generationResult = await playwrightMCP.generateTests({
        context: codebaseContext || { pages: [], apiEndpoints: [], workflows: [] },
        testType: config.testType,
        projectPath: config.projectPath,
        prdFile: config.prdFile,
      });
      Logger.info('PipelineWorker', `Generated test files via templates`, { count: generationResult.generated });

      // Also try SaaS backend if API key is set
      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
      if (testbotApiKey && codebaseContext) {
        Logger.info('PipelineWorker', 'Also generating tests via TestBot backend...');
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
            Logger.info('PipelineWorker', `Received test files from TestBot backend`, { count: generatedTests.length });

            const testsDir = path.join(config.projectPath, 'tests', 'generated');
            if (!fs.existsSync(testsDir)) {
              fs.mkdirSync(testsDir, { recursive: true });
            }
            for (const test of generatedTests) {
              const filePath = path.join(testsDir, test.filename);
              fs.writeFileSync(filePath, test.content, 'utf-8');
              Logger.info('PipelineWorker', `Wrote backend generated test`, { filename: test.filename, type: test.type });
            }
          } else {
            Logger.warn('PipelineWorker', `TestBot backend generation failed`, { status: genResponse.status });
          }
        } catch (e) {
          Logger.error('PipelineWorker', `TestBot backend generation error`, e);
        }
      }

      // Generate from Jira stories if available
      if (jiraStories && jiraStories.length > 0) {
        Logger.info('PipelineWorker', 'Generating tests from Jira stories...');
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
    Logger.info('PipelineWorker', 'Running Playwright tests...');

    const playwright = new PlaywrightIntegration(config);

    const mcpParallelEnabled = process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
                                process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    let testResults;

    if (mcpParallelEnabled) {
      Logger.info('PipelineWorker', 'Parallel execution enabled - running TestBot + Playwright MCP...');
      const playwrightMCPIntegration = new PlaywrightMCPIntegration({
        projectPath: config.projectPath,
        baseURL: config.baseURL,
      });

      const [directResults, mcpResults] = await Promise.all([
        playwright.runTests(),
        playwrightMCPIntegration.runTests()
      ]);

      Logger.info('PipelineWorker', `Test execution finished`, {
        directExecution: directResults.total,
        mcpExecution: mcpResults.available !== false ? mcpResults.total : 'unavailable'
      });

      const merger = new ResultsMerger({ projectPath: config.projectPath });
      testResults = merger.mergeResults(directResults, mcpResults);
    } else {
      testResults = await playwright.runTests();
    }

    Logger.info('PipelineWorker', `Tests completed`, { 
      total: testResults.total, 
      passed: testResults.passed, 
      failed: testResults.failed 
    });

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
    Logger.info('PipelineWorker', 'Generating report...');

    const reportGen = new ReportGenerator();
    const testbotApiKey = process.env.TESTBOT_API_KEY;
    const testbotDashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';

    if (testbotApiKey) {
      Logger.info('PipelineWorker', `Dashboard sync enabled`, { url: testbotDashboardUrl });
    } else {
      Logger.info('PipelineWorker', 'TESTBOT_API_KEY not set — skipping web dashboard sync');
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
      Logger.info('PipelineWorker', 'Opening dashboard...');
      try {
        dashboardUrl = await DashboardLauncher.open(report.path);
      } catch (e) {
        Logger.error('PipelineWorker', 'Dashboard open failed', e);
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

    Logger.info('PipelineWorker', `Pipeline complete`, { report: report.path, dashboard: dashboardUrl || report.url });

  } catch (error) {
    Logger.error('PipelineWorker', `Pipeline error`, error);

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
      Logger.error('PipelineWorker', `Fatal error`, err);
      process.exit(1);
    });
});
