#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runPipeline } = require('../testbot-mcp/src/pipeline-worker');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturesRoot = path.join(repoRoot, 'compat-fixtures');
const dashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://127.0.0.1:3000';
process.env.HEALIX_DASHBOARD_URL = dashboardUrl;

const FIXTURES = [
  {
    name: 'angular-public-app',
    projectName: 'Compat Angular Public App',
    path: 'angular-public-app',
    language: 'typescript',
    framework: 'angular',
    testType: 'frontend',
    port: 4210,
    minGeneratedTests: 5,
    startCommand: 'node server.mjs --port=4210',
    expected: { apiFiles: 0, uiFilesMin: 1 },
  },
  {
    name: 'react-vite-public-app',
    projectName: 'Compat React Vite Public App',
    path: 'react-vite-public-app',
    language: 'typescript',
    framework: 'vite-react',
    testType: 'frontend',
    port: 4220,
    minGeneratedTests: 5,
    startCommand: 'node server.mjs --port=4220',
    expected: { apiFiles: 0, uiFilesMin: 1 },
  },
  {
    name: 'nextjs-typescript-fullstack',
    projectName: 'Compat Next.js TypeScript Fullstack',
    path: 'nextjs-typescript-fullstack',
    language: 'typescript',
    framework: 'next',
    testType: 'both',
    port: 4230,
    minGeneratedTests: 7,
    startCommand: 'node server.mjs --port=4230',
    expected: { apiFilesMin: 1, uiFilesMin: 1 },
  },
  {
    name: 'node-api',
    projectName: 'Compat Node.js API',
    path: 'node-api',
    language: 'javascript',
    framework: 'express',
    testType: 'backend',
    port: 4240,
    minGeneratedTests: 4,
    startCommand: 'node server.mjs --port=4240',
    expected: { apiFilesMin: 1, uiFiles: 0 },
  },
  {
    name: 'java-api',
    projectName: 'Compat Java API',
    path: 'java-api',
    language: 'java',
    framework: 'gradle',
    testType: 'backend',
    port: 4250,
    minGeneratedTests: 4,
    startCommand: 'node server.mjs --port=4250',
    expected: { apiFilesMin: 1, uiFiles: 0 },
  },
  {
    name: 'dotnet-shaped-api',
    projectName: 'Compat .NET-Shaped API',
    path: 'dotnet-shaped-api',
    language: 'csharp',
    framework: 'dotnet-shaped',
    testType: 'backend',
    port: 4260,
    minGeneratedTests: 4,
    startCommand: 'node server.mjs --port=4260',
    expected: { apiFilesMin: 1, uiFiles: 0 },
  },
];

function parseArgs(argv) {
  const args = { fixture: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--fixture') args.fixture = argv[++i];
    else if (arg.startsWith('--fixture=')) args.fixture = arg.split('=')[1];
  }
  return args;
}

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanFixture(projectPath, runId) {
  rmSafe(path.join(projectPath, 'tests', 'generated'));
  rmSafe(path.join(projectPath, '.healix'));
  rmSafe(path.join(projectPath, 'healix-reports', 'results'));
  rmSafe(path.join(projectPath, 'healix-reports', '.runs', runId));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function findReport(projectPath, runId, startedAtMs) {
  const reportsDir = path.join(projectPath, 'healix-reports');
  if (!fs.existsSync(reportsDir)) return null;
  const candidates = fs.readdirSync(reportsDir)
    .filter((name) => /^report-.*\.json$/.test(name))
    .map((name) => path.join(reportsDir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs >= startedAtMs - 1000;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const file of candidates) {
    try {
      const report = readJson(file);
      if (report?.metadata?.runId === runId) return { file, report };
    } catch {
      // ignore bad candidate
    }
  }
  return null;
}

function listGeneratedFiles(projectPath) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) return [];
  return fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js|mjs|cjs)$/i.test(name))
    .map((name) => path.join(generatedDir, name));
}

function classifyGeneratedFiles(files) {
  let fallbackFiles = 0;
  let apiFiles = 0;
  let uiFiles = 0;
  for (const file of files) {
    const name = path.basename(file);
    const content = fs.readFileSync(file, 'utf-8');
    if (/^fallback-|template/i.test(name) || /Fallback (frontend|workflow|API|checks)|fallbackReason/i.test(content)) {
      fallbackFiles += 1;
    }
    if (/request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /\[CAT:api_/i.test(content)) {
      apiFiles += 1;
    } else {
      uiFiles += 1;
    }
  }
  return { fallbackFiles, apiFiles, uiFiles };
}

function assertFixtureResult({ fixture, projectPath, runId, reportFile, report, status }) {
  const errors = [];
  const stats = report.stats || {};
  const generatedFiles = listGeneratedFiles(projectPath);
  const generated = classifyGeneratedFiles(generatedFiles);
  const generationQuality = report.generationQuality || report.metadata?.generationMeta?.attempts?.at?.(-1)?.validation?.qualityAudit || {};
  const pipelineError = report.pipelineError || null;
  const dashboardLink = status?.dashboardUrl || '';

  if (generatedFiles.length === 0) errors.push('no generated spec files');
  if (generated.fallbackFiles > 0 || report.metadata?.fallbackUsed) errors.push('fallback/template specs were generated');
  if (Number(stats.total || 0) <= 0) errors.push('no tests reached execution');
  if (Number(stats.runnable || 0) <= 0) errors.push('zero runnable tests');
  if (Number(stats.skipped || 0) > 0) errors.push(`skipped tests present: ${stats.skipped}`);
  if (Number(stats.failed || 0) > 0) errors.push(`test failures present: ${stats.failed}`);
  if (pipelineError?.errorCode === 'PLAYWRIGHT_INFRASTRUCTURE_CRASH' || pipelineError?.errorCode === 'PLAYWRIGHT_EXECUTION_TIMEOUT') {
    errors.push(`unrecovered Playwright infrastructure failure: ${pipelineError.errorCode}`);
  }
  if (generationQuality.valid === false) errors.push(`generation quality failed: ${(generationQuality.errors || []).join(', ')}`);
  if (fixture.expected.apiFiles === 0 && generated.apiFiles > 0) errors.push(`unexpected API specs for frontend fixture: ${generated.apiFiles}`);
  if (fixture.expected.uiFiles === 0 && generated.uiFiles > 0) errors.push(`unexpected UI specs for backend fixture: ${generated.uiFiles}`);
  if (fixture.expected.apiFilesMin && generated.apiFiles < fixture.expected.apiFilesMin) errors.push(`missing API specs: ${generated.apiFiles}/${fixture.expected.apiFilesMin}`);
  if (fixture.expected.uiFilesMin && generated.uiFiles < fixture.expected.uiFilesMin) errors.push(`missing UI specs: ${generated.uiFiles}/${fixture.expected.uiFilesMin}`);
  if (!dashboardLink.startsWith(dashboardUrl)) errors.push(`dashboard sync missing or non-dashboard URL: ${dashboardLink || 'none'}`);

  return {
    fixture: fixture.name,
    runId,
    ok: errors.length === 0,
    errors,
    reportPath: reportFile,
    dashboardUrl: dashboardLink,
    stats,
    generated: {
      files: generatedFiles.length,
      ...generated,
    },
    routeAccessSummary: report.metadata?.routeAccessSummary || null,
  };
}

async function assertDashboardAvailable() {
  if (!process.env.HEALIX_API_KEY) {
    throw new Error('HEALIX_API_KEY is required for dashboard-backed compatibility matrix runs.');
  }
  const response = await fetch(`${dashboardUrl}/all-tests`, { redirect: 'manual' }).catch((error) => {
    throw new Error(`Dashboard is not reachable at ${dashboardUrl}: ${error.message}`);
  });
  if (!response || response.status >= 500) {
    throw new Error(`Dashboard is not healthy at ${dashboardUrl}; /all-tests returned ${response?.status}`);
  }
}

async function runFixture(fixture) {
  const projectPath = path.join(fixturesRoot, fixture.path);
  const runId = `compat-${Date.now()}-${fixture.name}`;
  const startedAtMs = Date.now();
  cleanFixture(projectPath, runId);

  const config = {
    projectPath,
    projectName: fixture.projectName,
    language: fixture.language,
    framework: fixture.framework,
    baseURL: `http://localhost:${fixture.port}`,
    port: fixture.port,
    startCommand: fixture.startCommand,
    testType: fixture.testType,
    generateTests: true,
    strictAIGeneration: true,
    generationMode: 'ai',
    minGeneratedTests: fixture.minGeneratedTests,
    coverageProfile: 'balanced',
    maxExpansionAttempts: 0,
    maxGenerationRepairAttempts: 0,
    phaseMode: 'single',
    validateGeneratedTests: true,
    enableExploration: fixture.testType !== 'backend',
    skipExploration: fixture.testType === 'backend',
    ideContextMode: 'off',
    headless: true,
    openDashboard: false,
    autoOpenBrowser: false,
    showMouseCursorInVideo: false,
    aiFailureAnalysis: false,
    playwrightCrashRetries: 1,
    stageCaps: {
      generation: 240000,
      execution: 180000,
      validation: 60000,
      reporting: 60000,
      dashboard: 30000,
    },
    maxRunMs: 540000,
    dashboardUrl,
    webappUrl: dashboardUrl,
  };

  console.log(`\n▶ ${fixture.name} (${fixture.testType}, ${fixture.framework})`);
  try {
    await runPipeline(config, runId);
  } catch (error) {
    const found = findReport(projectPath, runId, startedAtMs);
    if (found) {
      const statusPath = path.join(projectPath, 'healix-reports', '.runs', runId, 'status.json');
      const status = fs.existsSync(statusPath) ? readJson(statusPath) : null;
      const result = assertFixtureResult({ fixture, projectPath, runId, reportFile: found.file, report: found.report, status });
      result.ok = false;
      result.errors.unshift(error?.message || String(error));
      return result;
    }
    return {
      fixture: fixture.name,
      runId,
      ok: false,
      errors: [error?.message || String(error)],
      reportPath: null,
      dashboardUrl: null,
      stats: {},
      generated: classifyGeneratedFiles(listGeneratedFiles(projectPath)),
    };
  }

  const found = findReport(projectPath, runId, startedAtMs);
  if (!found) {
    return {
      fixture: fixture.name,
      runId,
      ok: false,
      errors: ['pipeline completed but no matching report was found'],
      reportPath: null,
      dashboardUrl: null,
      stats: {},
      generated: classifyGeneratedFiles(listGeneratedFiles(projectPath)),
    };
  }
  const statusPath = path.join(projectPath, 'healix-reports', '.runs', runId, 'status.json');
  const status = fs.existsSync(statusPath) ? readJson(statusPath) : null;
  return assertFixtureResult({ fixture, projectPath, runId, reportFile: found.file, report: found.report, status });
}

function printSummary(results) {
  console.log('\nCompatibility matrix summary');
  console.log('Fixture                         Status   Total Passed Failed Skipped Generated Dashboard');
  for (const result of results) {
    const stats = result.stats || {};
    const generated = result.generated || {};
    const row = [
      result.fixture.padEnd(31),
      (result.ok ? 'PASS' : 'FAIL').padEnd(8),
      String(stats.total ?? 0).padStart(5),
      String(stats.passed ?? 0).padStart(6),
      String(stats.failed ?? 0).padStart(6),
      String(stats.skipped ?? 0).padStart(7),
      String(generated.files ?? 0).padStart(9),
      result.dashboardUrl || '-',
    ].join(' ');
    console.log(row);
    if (!result.ok) {
      for (const error of result.errors) console.log(`  - ${error}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const fixture of FIXTURES) console.log(fixture.name);
    return;
  }

  const selected = args.fixture
    ? FIXTURES.filter((fixture) => fixture.name === args.fixture)
    : FIXTURES;
  if (selected.length === 0) {
    throw new Error(`Unknown fixture: ${args.fixture}. Use --list to see supported fixtures.`);
  }

  await assertDashboardAvailable();

  const results = [];
  for (const fixture of selected) {
    const result = await runFixture(fixture);
    results.push(result);
    console.log(`${result.ok ? '✓' : '✗'} ${fixture.name}: ${result.stats?.passed || 0}/${result.stats?.total || 0} passed`);
  }

  const outputDir = path.join(fixturesRoot, '.compat-runs');
  fs.mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    dashboardUrl,
    results,
  }, null, 2), 'utf-8');

  printSummary(results);
  console.log(`\nSummary JSON: ${summaryPath}`);

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
