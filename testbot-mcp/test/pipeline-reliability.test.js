const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyPipelineErrorFromStderr,
} = require('../src/failure-triage/pipeline-error-classifier');

const {
  buildRouteAccessSummary,
  allCredentialsCoveredByPreAuth,
  buildGenerationRepairContext,
  minimumUsefulRunnableFloor,
  adaptiveRunnableFloor,
  shouldAttemptCoverageTopUp,
  collectGenerationQuality,
  countSkippedTestsInContent,
  countTestsInContent,
  evaluateGenerationQualityGates,
  hasApiSurfaceForGeneration,
  effectiveApiEndpoints,
  auditGeneratedTestQuality,
  computeGenerationAgentTimeoutMs,
  estimateGenerationComplexity,
  extractQualityFailureFileNames,
  findGeneratedTestBlocks,
  getCursorFixtureContent,
  maybeRunFailureTriage,
  maybeExpandGenerationStageBudget,
  mergeCredentialInjectionRoles,
  isRepairableGenerationFailure,
  isBrittleGeneratedTestBlock,
  isSyntheticHealthEndpoint,
  pickAgentsForRun,
  pruneGeneratedTestsByQuality,
  quarantineGeneratedSpecFiles,
  resolveGenerationAgentConcurrency,
  shouldAutoSwitchPortForConflict,
  shouldTrustDiscoveredAuthFlow,
  buildTargetPortInUseError,
  rewriteStartCommandForPort,
  writeSupplementalAuthConfig,
} = require('../src/pipeline-worker');
const { startSecondaryServices } = require('../src/multi-service-starter');
const ReportGenerator = require('../src/report-generator');

function withGeneratedSuite(content, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-pipeline-'));
  const generatedDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'generated.spec.ts'), content);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('counts runnable declarations separately from skipped declarations and runtime skips', () => {
  const content = `
    import { test } from '@playwright/test';

    test('public route runs', async ({ page }) => {
      await page.goto('/');
      test.skip(false, 'runtime condition should not create a second test');
    });

    test('runtime auth guard is skipped', async ({ page }) => {
      test.skip(true, 'Requires credentials that are missing');
      await page.goto('/dashboard');
    });

    test.skip('protected admin route', async ({ page }) => {
      await page.goto('/admin');
    });
  `;

  assert.equal(countTestsInContent(content), 3);
  assert.equal(countSkippedTestsInContent(content), 2);
});

test('quality gates reject all-skipped generated suites', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('dashboard requires credentials', async ({ page }) => {
      test.skip(true, 'Requires signed-in credentials');
      await page.goto('/dashboard');
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    assert.equal(quality.totalTests, 1);
    assert.equal(quality.skippedTests, 1);
    assert.equal(quality.runnableTests, 0);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'balanced' },
      context: { pages: [{ path: '/' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'ZERO_RUNNABLE_TESTS');
  });
});

test('quality gates reject low runnable coverage', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('home page runs', async ({ page }) => {
      await page.goto('/');
    });

    test.skip('admin area blocked', async ({ page }) => {
      await page.goto('/admin');
    });

    test.skip('settings area blocked', async ({ page }) => {
      await page.goto('/settings');
    });

    test.skip('billing area blocked', async ({ page }) => {
      await page.goto('/billing');
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 1 },
      context: { pages: [{ path: '/' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(quality.runnableRatio, 0.25);
    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'RUNNABLE_COVERAGE_TOO_LOW');
  });
});

function generatedRunnableTests(count) {
  return Array.from({ length: count }, (_, index) => `
    test('source grounded workflow ${index}', async ({ page }) => {
      await page.goto('/route-${index}');
      await expect(page.getByRole('heading', { name: 'Route ${index}' })).toBeVisible();
    });
  `).join('\n');
}

test('quality gates execute valid suites that miss target but meet minimum useful floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(26)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 26 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(minimumUsefulRunnableFloor(50), 12);
    assert.equal(adaptiveRunnableFloor(50), 12);
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.minGeneratedTestsTarget, 50);
    assert.equal(gate.result.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.result.adaptiveRunnableFloor, 12);
    assert.equal(gate.result.generatedTestsActual, 26);
    assert.equal(gate.result.runnableTestsActual, 26);
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
    assert.equal(gate.result.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
  });
});

test('quality gates execute useful 12-test suites that miss target 50', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(12)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 12 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.result.runnableTestsActual, 12);
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
    assert.equal(gate.result.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
  });
});

test('quality gates fail below minimum useful runnable floor after top-up', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(8)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { projectPath, testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 50 },
      context: { pages: Array.from({ length: 8 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'INSUFFICIENT_RUNNABLE_COVERAGE');
    assert.equal(gate.error.generationQuality.minimumUsefulRunnableFloor, 12);
    assert.equal(gate.error.generationQuality.qualityWarnings[0].code, 'MIN_TEST_COUNT_NOT_MET');
    assert.equal(gate.error.diagnostics.generatedSpecCount, 1);
  });
});

test('coverage top-up decision runs once for nonzero suites below target', () => {
  const decision = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 12, runnableTests: 12 },
  });
  assert.equal(decision.attempt, true);
  assert.equal(decision.target, 50);
  assert.equal(decision.minimumUsefulRunnableFloor, 12);

  const zeroRunnable = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 12, runnableTests: 0 },
  });
  assert.equal(zeroRunnable.attempt, false);
  assert.equal(zeroRunnable.reason, 'no_runnable_tests');

  const targetMet = shouldAttemptCoverageTopUp({
    config: { minGeneratedTests: 50 },
    quality: { totalTests: 50, runnableTests: 50 },
  });
  assert.equal(targetMet.attempt, false);
  assert.equal(targetMet.reason, 'target_met');
});

test('quality gates allow small targets at the minimum useful floor', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';
    ${generatedRunnableTests(8)}
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath);
    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'qa-max', minGeneratedTests: 20 },
      context: { pages: Array.from({ length: 8 }, (_, index) => ({ path: `/route-${index}` })) },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(minimumUsefulRunnableFloor(20), 8);
    assert.equal(adaptiveRunnableFloor(20), 8);
    assert.equal(gate.ok, true);
    assert.equal(gate.result.qualityGateStatus, 'warning');
    assert.equal(gate.result.executionAllowedDespiteWarnings, true);
  });
});

test('quality gates reject hardcoded origins that do not match configured baseURL', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('calendar route runs', async ({ page }) => {
      await page.goto('http://localhost:5174/calendar');
      await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath, { baseURL: 'http://localhost:5173' });
    assert.equal(quality.hardcodedBaseUrlMismatches.length, 1);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'frontend', coverageProfile: 'balanced', baseURL: 'http://localhost:5173' },
      context: { pages: [{ path: '/calendar' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'HARDCODED_BASE_URL_MISMATCH');
    assert.equal(gate.error.diagnostics.stage, 'generation');
    assert.equal(gate.error.diagnostics.reason, 'hardcoded_base_url_mismatch');
    assert.equal(gate.error.diagnostics.errorCode, 'HARDCODED_BASE_URL_MISMATCH');
  });
});

test('pipeline error classifier treats hardcoded baseURL mismatch as generation quality failure', () => {
  const classified = classifyPipelineErrorFromStderr({
    stderr: 'Generated suite hardcoded a different app origin than baseURL (api-suite.spec.ts:https://example.com).',
    hintedStage: null,
  });

  assert.equal(classified.stage, 'generation');
  assert.equal(classified.reason, 'hardcoded_base_url_mismatch');
  assert.equal(classified.errorCode, 'HARDCODED_BASE_URL_MISMATCH');
});

test('pipeline error classifier treats min-count and useful-floor failures as generation issues', () => {
  const legacyMin = classifyPipelineErrorFromStderr({
    stderr: 'Generated tests 26 below minimum 50 for strict profile qa-max',
  });
  assert.equal(legacyMin.stage, 'generation');
  assert.equal(legacyMin.reason, 'min_test_count_not_met');
  assert.equal(legacyMin.errorCode, 'MIN_TEST_COUNT_NOT_MET');

  const insufficient = classifyPipelineErrorFromStderr({
    stderr: 'Generated runnable tests 8 below minimum useful floor 12 for target 50.',
  });
  assert.equal(insufficient.stage, 'generation');
  assert.equal(insufficient.reason, 'insufficient_runnable_coverage');
  assert.equal(insufficient.errorCode, 'INSUFFICIENT_RUNNABLE_COVERAGE');
});

test('pipeline error classifier treats occupied unreachable target port as setup failure', () => {
  const classified = classifyPipelineErrorFromStderr({
    stderr: 'TARGET_PORT_IN_USE_NOT_READY: Configured target port 8080 is already in use, but http://localhost:8080 is not HTTP-ready.',
  });

  assert.equal(classified.stage, 'server_start');
  assert.equal(classified.reason, 'target_port_in_use_not_ready');
  assert.equal(classified.errorCode, 'TARGET_PORT_IN_USE_NOT_READY');
});

test('quality gates reject placeholder external API hosts even without a configured baseURL', () => {
  withGeneratedSuite(`
    import { test, expect, request } from '@playwright/test';

    test('placeholder api contract', async ({ request }) => {
      const response = await request.get('https://example.com/api/tasks');
      expect(response.status()).toBe(200);
    });
  `, (projectPath) => {
    const quality = collectGenerationQuality(projectPath, {});
    assert.equal(quality.hardcodedBaseUrlMismatches.length, 1);
    assert.equal(quality.hardcodedBaseUrlMismatches[0].placeholderExternalUrl, true);

    const gate = evaluateGenerationQualityGates({
      config: { testType: 'backend', coverageProfile: 'balanced', projectPath },
      context: { apiEndpoints: [{ method: 'GET', path: '/api/tasks' }] },
      quality,
      prdContent: '',
      parsedPRD: {},
      requirementsCoverage: {},
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.error.code, 'HARDCODED_BASE_URL_MISMATCH');
  });
});

test('quality audit rejects UI specs that are not grounded in target source text', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('generic dashboard gimmick', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Completely Invented Screen')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><button>Add Task</button></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: { pages: [{ path: '/', description: 'Project Insights dashboard' }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_ui_files:')));
  });
});

test('quality audit accepts UI specs grounded to source files and observed routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('[REQ:F1.S1.AC1] source-grounded dashboard', async ({ page }) => {
      // [SRC:src/App.tsx] App source renders the Project Insights dashboard route.
      await page.goto('/projects');
      await expect(page.getByRole('heading', { name: 'Project Insights' })).toBeVisible();
      await expect(page.getByText('Kanban Board')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><h2>Kanban Board</h2></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/projects', sourceFile: 'src/App.tsx', description: 'Project Insights Kanban Board' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/projects'], assertableText: ['Project Insights', 'Kanban Board'] }],
          routePaths: ['/projects'],
          assertableText: ['Project Insights', 'Kanban Board'],
        },
      },
      explorationArtifact: {
        routes: [
          {
            path: '/projects',
            requiresAuth: false,
            headings: [{ text: 'Project Insights' }, { text: 'Kanban Board' }],
          },
        ],
      },
    });

    assert.equal(audit.valid, true);
  });
});

test('quality audit rejects missing source references, invented selector text, and unknown routes', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('[REQ:F1.S1.AC1] invented flow', async ({ page }) => {
      await page.goto('/made-up-route');
      await expect(page.getByText('Imaginary Approval Workflow')).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx', description: 'Project Insights' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', routePaths: ['/'], assertableText: ['Project Insights'] }],
          routePaths: ['/'],
          assertableText: ['Project Insights'],
        },
      },
      explorationArtifact: {
        routes: [{ path: '/', requiresAuth: false, headings: [{ text: 'Project Insights' }] }],
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('missing_source_reference:')));
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_selector_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('ungrounded_route:')));
  });
});

test('quality audit rejects unblocked protected-route tests when credentials are unavailable', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('account login reaches protected account page', async ({ page }) => {
      // [SRC:src/account.tsx] Account route requires a signed-in session.
      await page.goto('/account');
      await page.getByLabel('Email').fill('user@example.com');
      await page.getByLabel('Password').fill('password');
      await page.getByRole('button', { name: 'Sign In' }).click();
      await expect(page).toHaveURL(/\\/account$/);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, 'src', 'account.tsx'),
      '<main><h1>Account</h1><label htmlFor="email">Email</label><input id="email" /><label htmlFor="password">Password</label><input id="password" /><button>Sign In</button></main>',
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account', 'Email', 'Password', 'Sign In'], routePaths: ['/account'] }],
          assertableText: ['Account', 'Email', 'Password', 'Sign In'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [],
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('unblocked_protected_route_without_credentials:generated.spec.ts:1'));
  });
});

test('quality audit allows skipped protected-route tests when credentials are unavailable', () => {
  withGeneratedSuite(`
    import { test } from '@playwright/test';

    test('account route is blocked without credentials', async ({ page }) => {
      test.skip(true, 'Requires admin credentials — not available in this run');
      // [SRC:src/account.tsx] Account route requires a signed-in session.
      await page.goto('/account');
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'account.tsx'), '<main><h1>Account</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account'], routePaths: ['/account'] }],
          assertableText: ['Account'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [],
    });

    assert.ok(!audit.errors.some((error) => error.startsWith('unblocked_protected_route_without_credentials')));
  });
});

test('quality audit allows protected-route success assertions when credentials are verified', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('admin reaches account page with storage state', async ({ page }) => {
      // [SRC:src/account.tsx] Account route is reachable for a verified authenticated role.
      await page.goto('/account');
      await expect(page).toHaveURL(/\\/account$/);
      await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'account.tsx'), '<main><h1>Account</h1></main>');
    const storageStatePath = path.join(projectPath, '.healix', 'auth-state-admin.json');
    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    fs.writeFileSync(storageStatePath, '{"cookies":[],"origins":[]}', 'utf-8');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/account', sourceFile: 'src/account.tsx' }],
        sourceContext: {
          files: [{ file: 'src/account.tsx', assertableText: ['Account'], routePaths: ['/account'] }],
          assertableText: ['Account'],
          routePaths: ['/account'],
        },
      },
      explorationArtifact: { routes: [{ path: '/account', requiresAuth: true }] },
      roles: [{ role: 'admin', loginVerified: true, storageStatePath }],
    });

    assert.ok(!audit.errors.some((error) => error.startsWith('unblocked_protected_route_without_credentials')));
  });
});

test('healix fixture injects verified auth state for tagged tests outside tierB projects', () => {
  const { ts } = getCursorFixtureContent('', 'module', [], [
    { role: 'Administrator', name: 'Administrator', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' },
  ]);

  assert.match(ts, /tierB-auth-\(\.\+\)/);
  assert.match(ts, /_isAuthTagged/);
  assert.match(ts, /auth-state-admin\.json/);
  assert.match(ts, /"admin": "\/tmp\/auth-state-admin\.json"/);
});

test('supplemental auth config normalizes role aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-config-'));
  try {
    const configPath = writeSupplementalAuthConfig(root, 'http://localhost:3000', [
      { role: 'Administrator', name: 'Administrator', loginVerified: true, storageStatePath: '/tmp/auth-state-admin.json' },
    ]);
    const config = fs.readFileSync(configPath, 'utf-8');
    assert.match(config, /name: 'tierB-auth-admin'/);
    assert.doesNotMatch(config, /Administrator/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality audit rejects brittle implementation-detail UI assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('brittle generated assertions', async ({ page }) => {
      await page.goto('/projects');
      const main = page.locator('main');
      await expect(main).toContainText(['Project Insights', 'Kanban Board']);
      await expect(page.getByRole('button', { name: 'Priority: MediumAPI Schema ValidationImplement Zod schemas for all endpointsDue: Nov 28Assignee:' })).toBeVisible();
      await page.locator('form').evaluate((form) => (form as HTMLFormElement).checkValidity());
      await page.getByRole('button', { name: 'Add Task' }).evaluate((el) => getComputedStyle(el).borderRadius);
      await page.getByRole('button', { name: 'New Project', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Next Month' }).click();
      await expect(page.getByRole('button', { name: 'Standup' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'May 2026 —Monthly View' })).toBeVisible();
      await page.getByRole('button', { name: 'Previous Month' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Showing May 2026' })).toBeVisible();
      const teamFilter = page.locator('select');
      const label = 'Alpha Team';
      await teamFilter.selectOption('t1');
      await expect(page.getByText(label)).toBeVisible();
      await expect(page.getByText('Due: Dec 1')).toBeVisible();
      await expect(page.getByText('Review')).toBeVisible();
      await expect(page.getByRole('button', { name: /Priority: MediumAPI Schema Validation/ })).toBeVisible();
    });
  `, (projectPath) => {
    const srcDir = path.join(projectPath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      `export function App(){ return <main><h1>Project Insights</h1><h2>Kanban Board</h2><button>Add Task</button><span>API Schema Validation</span></main> }`,
    );

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: { pages: [{ path: '/projects', description: 'Project Insights Kanban Board API Schema Validation Add Task' }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_array_to_contain_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_concatenated_accessible_name:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_check_validity_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_computed_style_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_unproven_dialog_after_new_project:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_cross_month_event_assertion:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_select_option_label_visibility:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_invented_due_label:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_ambiguous_single_word_text:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_stale_month_after_navigation:')));
    assert.ok(audit.errors.some((error) => error.startsWith('brittle_concatenated_accessible_name_regex:')));
  });
});

test('quality audit rejects brittle strict console error assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('public route has no console errors', async ({ page }) => {
      // [SRC:src/App.tsx] App source renders the public Home route.
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'App.tsx'), '<main><h1>Home</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', assertableText: ['Home'], routePaths: ['/'] }],
          assertableText: ['Home'],
          routePaths: ['/'],
        },
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_strict_console_errors_assertion:generated.spec.ts'));
  });
});

test('quality audit rejects ambiguous generic getByText and console poll helpers', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    async function assertNoConsoleErrors(page) {
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await expect.poll(() => errors.length, { timeout: 1000 }).toBe(0);
    }

    test('public filters are visible', async ({ page }) => {
      // [SRC:src/Shop.tsx] Shop source renders a public filter list.
      await page.goto('/shop');
      await expect(page.getByRole('heading', { name: 'Shop Collection' })).toBeVisible();
      await expect(page.getByText('All')).toBeVisible();
      await assertNoConsoleErrors(page);
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'Shop.tsx'), '<main><h1>Shop Collection</h1><label><input />All</label><footer>All rights reserved</footer></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [{ path: '/shop', sourceFile: 'src/Shop.tsx' }],
        sourceContext: {
          files: [{ file: 'src/Shop.tsx', assertableText: ['Shop Collection', 'All'], routePaths: ['/shop'] }],
          assertableText: ['Shop Collection', 'All'],
          routePaths: ['/shop'],
        },
      },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_ambiguous_single_word_text:generated.spec.ts'));
    assert.ok(audit.errors.includes('brittle_strict_console_errors_assertion:generated.spec.ts'));
  });
});

test('quality audit rejects unobserved dynamic detail links and mismatched source assertions', () => {
  withGeneratedSuite(`
    import { test, expect } from '@playwright/test';

    test('lookbook and product detail flow', async ({ page }) => {
      // [SRC:src/Lookbook.tsx] Lookbook source renders public editorial content.
      await page.goto('/lookbook');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: 'Lookbook' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 3, name: 'THEA' })).toBeVisible();
      await expect(main).toContainText('THEA');

      // [SRC:src/Shop.tsx] Dynamic product links must be observed before tests require them.
      await page.goto('/shop');
      const productLink = page.locator('main a[href*="/shop/"]').first();
      const href = await productLink.getAttribute('href');
      expect(href).toBeTruthy();
    });
  `, (projectPath) => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'Lookbook.tsx'), '<main><h1>Lookbook</h1></main>');
    fs.writeFileSync(path.join(projectPath, 'src', 'Shop.tsx'), '<main><h1>Shop Collection</h1></main>');

    const audit = auditGeneratedTestQuality({
      projectPath,
      testType: 'frontend',
      context: {
        pages: [
          { path: '/lookbook', sourceFile: 'src/Lookbook.tsx' },
          { path: '/shop', sourceFile: 'src/Shop.tsx' },
        ],
        sourceContext: {
          files: [
            { file: 'src/Lookbook.tsx', assertableText: ['Lookbook'], routePaths: ['/lookbook'] },
            { file: 'src/Shop.tsx', assertableText: ['Shop Collection'], routePaths: ['/shop'] },
          ],
          assertableText: ['Lookbook', 'Shop Collection'],
          routePaths: ['/lookbook', '/shop'],
        },
      },
      explorationArtifact: { routes: [{ path: '/lookbook', requiresAuth: false }, { path: '/shop', requiresAuth: false }] },
    });

    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('brittle_unobserved_dynamic_detail_link_assertion:generated.spec.ts'));
    assert.ok(audit.errors.some((error) => error.startsWith('assertion_not_in_declared_source:generated.spec.ts:')));
  });
});

test('backend agents are selected only for explicit or discovered API surfaces', () => {
  const frontendOnlyProject = { services: [{ name: 'web', role: 'frontend' }] };
  const frontendContext = { pages: [{ path: '/' }], forms: [], workflows: [] };

  assert.equal(hasApiSurfaceForGeneration(frontendContext, frontendOnlyProject), false);
  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, frontendContext),
    ['smoke', 'frontend']
  );

  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, {
      pages: [{ path: '/' }],
      workflows: [{ name: 'Create task' }],
      errorScenarios: [{ name: 'Required field validation' }],
    }),
    ['smoke', 'frontend', 'workflow', 'error']
  );

  const apiContext = { apiEndpoints: [{ method: 'GET', path: '/api/projects' }] };
  assert.equal(hasApiSurfaceForGeneration(apiContext, frontendOnlyProject), true);
  assert.ok(pickAgentsForRun('both', frontendOnlyProject, apiContext).includes('api'));
  assert.deepEqual(pickAgentsForRun('backend', frontendOnlyProject, {}), ['smoke', 'api']);
});

test('synthetic health endpoints do not activate backend generation for frontend apps', () => {
  const frontendOnlyProject = { services: [{ name: 'web', role: 'frontend' }] };
  const syntheticHealthContext = {
    pages: [{ path: '/' }],
    apiEndpoints: [
      { method: 'GET', path: '/api/health', synthetic: true, source: 'healix_fallback' },
    ],
    mockableApiContracts: [],
  };

  assert.equal(isSyntheticHealthEndpoint(syntheticHealthContext.apiEndpoints[0]), true);
  assert.deepEqual(effectiveApiEndpoints(syntheticHealthContext), []);
  assert.equal(hasApiSurfaceForGeneration(syntheticHealthContext, frontendOnlyProject), false);
  assert.deepEqual(
    pickAgentsForRun('both', frontendOnlyProject, syntheticHealthContext),
    ['smoke', 'frontend']
  );
});

test('quality quarantine removes only file-specific bad generated specs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-quarantine-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'good.spec.ts'), `import { test } from '@playwright/test'; test('good', async () => {});`);
    fs.writeFileSync(path.join(generatedDir, 'bad.spec.ts'), `import { test } from '@playwright/test'; test('bad', async () => {});`);

    const qualityAudit = {
      errors: ['brittle_array_to_contain_text:bad.spec.ts'],
      brittlePatternFiles: ['bad.spec.ts'],
    };
    assert.deepEqual(extractQualityFailureFileNames(qualityAudit), ['bad.spec.ts']);

    const recovery = quarantineGeneratedSpecFiles({ projectPath: root, qualityAudit, reason: 'test' });
    assert.equal(recovery.applied, true);
    assert.deepEqual(recovery.quarantinedFiles.map((file) => file.filename), ['bad.spec.ts']);
    assert.equal(fs.existsSync(path.join(generatedDir, 'good.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(generatedDir, 'bad.spec.ts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality pruning removes only brittle generated test blocks inside a mixed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-prune-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    const content = `
      import { test, expect } from '@playwright/test';

      test('good public dashboard assertion', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Project Insights' })).toBeVisible();
      });

      test('bad generated card assertion', async ({ page }) => {
        await page.goto('/projects');
        await expect(page.getByRole('button', { name: /Priority: MediumAPI Schema Validation/ })).toBeVisible();
      });

      test('good public calendar assertion', async ({ page }) => {
        await page.goto('/calendar');
        await expect(page.getByRole('heading', { name: 'May 2026 —Monthly View' })).toBeVisible();
      });
    `;
    fs.writeFileSync(path.join(generatedDir, 'mixed.spec.ts'), content);

    const blocks = findGeneratedTestBlocks(content);
    assert.equal(blocks.length, 3);
    assert.equal(isBrittleGeneratedTestBlock(blocks[1].content), true);

    const recovery = pruneGeneratedTestsByQuality({
      projectPath: root,
      qualityAudit: { errors: ['brittle_concatenated_accessible_name_regex:mixed.spec.ts'] },
      reason: 'test',
    });
    assert.equal(recovery.applied, true);
    assert.deepEqual(recovery.prunedFiles.map((file) => ({
      filename: file.filename,
      removedTests: file.removedTests,
      remainingTests: file.remainingTests,
    })), [{ filename: 'mixed.spec.ts', removedTests: 1, remainingTests: 2 }]);

    const nextContent = fs.readFileSync(path.join(generatedDir, 'mixed.spec.ts'), 'utf-8');
    assert.equal(countTestsInContent(nextContent), 2);
    assert.equal(nextContent.includes('Priority: MediumAPI Schema Validation'), false);
    assert.equal(nextContent.includes('good public dashboard assertion'), true);
    assert.equal(nextContent.includes('good public calendar assertion'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quality quarantine refuses to remove the entire generated suite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-quality-quarantine-all-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'only.spec.ts'), `import { test } from '@playwright/test'; test('only', async () => {});`);

    const recovery = quarantineGeneratedSpecFiles({
      projectPath: root,
      qualityAudit: { errors: ['missing_source_reference:only.spec.ts'] },
      reason: 'test',
    });
    assert.equal(recovery.applied, false);
    assert.equal(recovery.reason, 'would_quarantine_entire_suite');
    assert.equal(fs.existsSync(path.join(generatedDir, 'only.spec.ts')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('route access summary marks reachable public apps without auth flow', () => {
  const summary = buildRouteAccessSummary({
    authFlow: null,
    routes: [
      { path: '/', requiresAuth: false },
      { path: '/projects', requiresAuth: false },
      { path: '/admin', requiresAuth: true },
    ],
  });

  assert.equal(summary.authMode, 'public_app');
  assert.equal(summary.authFlowDetected, false);
  assert.deepEqual(summary.publicRoutes, ['/', '/projects']);
  assert.deepEqual(summary.protectedRoutes, ['/admin']);
});

test('auth reinjection merge preserves verified pre-auth storageState when fresh login fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-auth-merge-'));
  try {
    const statePath = path.join(root, 'auth-state-admin.json');
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const preAuthRoles = [
      { role: 'admin', storageStatePath: statePath, loginVerified: true },
    ];
    const freshRoles = [
      { role: 'admin', storageStatePath: null, loginVerified: false, reason: 'Login failed on /register: email_in_use' },
    ];

    assert.equal(allCredentialsCoveredByPreAuth([{ role: 'admin' }], preAuthRoles), true);
    const merged = mergeCredentialInjectionRoles({ freshRoles, preAuthRoles });

    assert.equal(merged.roles.length, 1);
    assert.equal(merged.roles[0].loginVerified, true);
    assert.equal(merged.roles[0].storageStatePath, statePath);
    assert.equal(merged.roles[0].reusedFromPreAuth, true);
    assert.deepEqual(merged.reusedPreAuthRoles, ['admin']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline trusts login authFlow but refuses register authFlow for reinjection', () => {
  assert.equal(shouldTrustDiscoveredAuthFlow({
    loginUrl: '/login',
    credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    score: 120,
    intent: 'login',
  }), true);
  assert.equal(shouldTrustDiscoveredAuthFlow({
    loginUrl: '/register',
    credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    score: -50,
    intent: 'register',
  }), false);
});

test('generation repair context feeds quality failures back into the next generation call', () => {
  const error = new Error('Generated suite has zero runnable tests');
  error.code = 'ZERO_RUNNABLE_TESTS';
  const context = buildGenerationRepairContext({
    context: { pages: [{ path: '/' }] },
    error,
    quality: {
      totalTests: 12,
      skippedTests: 12,
      runnableTests: 0,
      runnableRatio: 0,
      missingCategories: ['ui_flow', 'workflow_journey'],
      errors: ['zero_runnable_tests'],
    },
    routeAccessSummary: {
      authMode: 'public_app',
      publicRoutes: ['/', '/projects', '/calendar'],
      protectedRoutes: ['/admin'],
    },
    attempt: 1,
    testType: 'frontend',
  });

  assert.equal(isRepairableGenerationFailure(error), true);
  assert.equal(context.generationFeedback.previousFailureCode, 'ZERO_RUNNABLE_TESTS');
  assert.equal(context.generationFeedback.quality.runnableTests, 0);
  assert.deepEqual(context.generationFeedback.quality.missingCategories, ['ui_flow', 'workflow_journey']);
  assert.ok(
    context.generationFeedback.instructions.some((instruction) =>
      instruction.includes('/projects')
    )
  );
});

test('generation transport timeout scales from stage budget and codebase complexity', () => {
  const previousAgentTimeout = process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
  const previousWebappTimeout = process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
  const previousDashboardUrl = process.env.HEALIX_DASHBOARD_URL;
  delete process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
  delete process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
  delete process.env.HEALIX_DASHBOARD_URL;
  try {
    const largeContext = {
      pages: Array.from({ length: 24 }, (_, index) => ({ path: `/page-${index}` })),
      workflows: Array.from({ length: 12 }, (_, index) => ({ name: `Workflow ${index}` })),
      apiEndpoints: Array.from({ length: 8 }, (_, index) => ({ method: 'GET', path: `/api/${index}` })),
    };
    const parsedPRD = {
      features: [
        {
          userStories: [
            { acceptanceCriteria: Array.from({ length: 20 }, (_, index) => ({ id: `AC-${index}` })) },
          ],
        },
      ],
    };
    const runBudget = {
      startedAt: Date.now(),
      totalMs: 7_200_000,
      stageCaps: { generation: 3_600_000 },
      stageDeadlines: { generation: Date.now() + 3_600_000 },
    };
    const agents = ['smoke', 'frontend', 'workflow', 'error'];
    const concurrency = resolveGenerationAgentConcurrency({ generationAgentConcurrency: 2 }, agents);
    const complexity = estimateGenerationComplexity({
      context: largeContext,
      parsedPRD,
      minGeneratedTests: 90,
    });
    const timeoutMs = computeGenerationAgentTimeoutMs({
      config: {
        minGeneratedTests: 90,
        dashboardUrl: 'http://localhost:3000',
        generationAgentConcurrency: 2,
      },
      runBudget,
      agents,
      concurrency,
      context: largeContext,
      parsedPRD,
    });

    assert.equal(complexity.tier, 'xlarge');
    assert.equal(concurrency, 2);
    assert.ok(timeoutMs >= 600_000, `expected at least 10 minutes, got ${timeoutMs}`);
    assert.ok(timeoutMs <= 1_800_000, `timeout should stay inside the generation stage budget, got ${timeoutMs}`);
  } finally {
    if (previousAgentTimeout === undefined) delete process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS;
    else process.env.HEALIX_GENERATION_AGENT_TIMEOUT_MS = previousAgentTimeout;
    if (previousWebappTimeout === undefined) delete process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS;
    else process.env.HEALIX_WEBAPP_AGENT_TIMEOUT_MS = previousWebappTimeout;
    if (previousDashboardUrl === undefined) delete process.env.HEALIX_DASHBOARD_URL;
    else process.env.HEALIX_DASHBOARD_URL = previousDashboardUrl;
  }
});

test('generation stage budget expands for large codebases unless user set an explicit cap', () => {
  const previousGenBudget = process.env.HEALIX_GEN_BUDGET_MS;
  delete process.env.HEALIX_GEN_BUDGET_MS;
  try {
    const runBudget = {
      startedAt: Date.now(),
      totalMs: 7_200_000,
      stageCaps: { generation: 1_800_000 },
    };
    const complexity = maybeExpandGenerationStageBudget({
      runBudget,
      config: { minGeneratedTests: 100 },
      context: {
        pages: Array.from({ length: 36 }, (_, index) => ({ path: `/page-${index}` })),
        workflows: Array.from({ length: 14 }, (_, index) => ({ name: `Workflow ${index}` })),
      },
      parsedPRD: {
        features: [
          {
            userStories: [
              { acceptanceCriteria: Array.from({ length: 25 }, (_, index) => ({ id: `AC-${index}` })) },
            ],
          },
        ],
      },
      projectInfo: {},
    });

    assert.equal(complexity.tier, 'xlarge');
    assert.equal(runBudget.stageCaps.generation, 3_600_000);
  } finally {
    if (previousGenBudget === undefined) delete process.env.HEALIX_GEN_BUDGET_MS;
    else process.env.HEALIX_GEN_BUDGET_MS = previousGenBudget;
  }
});

test('port conflict rewrite updates the dev start command with the reassigned port', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-port-rewrite-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^6.0.0' } }),
    );
    assert.equal(
      rewriteStartCommandForPort('npm run dev -- --port 5173', 5174, root),
      'npm run dev -- --port 5174'
    );
    assert.equal(
      rewriteStartCommandForPort('npm run dev', 5174, root),
      'npm run dev -- --port 5174'
    );
    assert.equal(
      rewriteStartCommandForPort('PORT=3000 npm start', 3001, root),
      'PORT=3001 npm start'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('port conflict fallback is disabled for multi-service stacks by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-port-policy-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^6.0.0' } }),
    );
    assert.equal(shouldAutoSwitchPortForConflict({
      projectPath: root,
      startCommand: 'npm run dev',
      services: [
        { role: 'frontend', port: 8080 },
        { role: 'backend', port: 5002 },
      ],
    }), false);
    assert.equal(shouldAutoSwitchPortForConflict({
      projectPath: root,
      startCommand: 'npm run dev',
      services: [
        { role: 'frontend', port: 8080 },
        { role: 'backend', port: 5002 },
      ],
      allowPortFallback: true,
    }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('target port busy error is classified as server-start setup failure', () => {
  const err = buildTargetPortInUseError({
    configuredPort: 8080,
    config: {
      baseURL: 'http://localhost:8080',
      startCommand: 'npm start',
      services: [{ role: 'backend', port: 5002 }],
    },
  });

  assert.equal(err.code, 'TARGET_PORT_IN_USE_NOT_READY');
  assert.equal(err.diagnostics.stage, 'server_start');
  assert.equal(err.diagnostics.reason, 'target_port_in_use_not_ready');
  assert.match(err.message, /will not start a duplicate multi-service stack/);
});

test('secondary service starter reuses an already-running backend service', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-secondary-reuse-'));

  try {
    const readyEvents = [];
    const started = await startSecondaryServices({
      projectPath: root,
      waitMs: 1000,
      services: [
        { role: 'frontend', port: 8080, startCommand: 'npm run dev' },
        {
          role: 'backend',
          port,
          baseURL: `http://127.0.0.1:${port}`,
          startCommand: 'node -e "process.exit(99)"',
        },
      ],
      onReady: (event) => readyEvents.push(event),
    });

    assert.equal(started.length, 1);
    assert.equal(started[0].reused, true);
    assert.equal(started[0].pid, null);
    assert.equal(started[0].ready, true);
    assert.equal(readyEvents[0]?.reused, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure triage reports skipped status without creating AI analysis', async () => {
  const disabled = await maybeRunFailureTriage({
    config: { aiFailureAnalysis: false },
    testResults: { failures: [] },
    runBudget: null,
    runId: 'triage-disabled',
  });
  assert.equal(disabled.analysis, null);
  assert.equal(disabled.triage.aiTriageStatus, 'skipped_disabled');

  const noFailures = await maybeRunFailureTriage({
    config: { aiFailureAnalysis: true },
    testResults: { failures: [] },
    runBudget: null,
    runId: 'triage-clean',
  });
  assert.equal(noFailures.analysis, null);
  assert.equal(noFailures.triage.aiTriageStatus, 'skipped_no_failures');
});

test('report generator records triage metadata without empty AI summary', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-report-triage-'));
  try {
    const reportGen = new ReportGenerator();
    const generated = await reportGen.generate({
      projectPath,
      projectName: 'triage-app',
      runId: 'triage-report',
      testResults: {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 10,
        tests: [{ title: 'fails', status: 'failed', file: 'tests/fails.spec.ts' }],
        failures: [{ testName: 'fails', file: 'tests/fails.spec.ts', error: 'boom' }],
      },
      aiAnalysis: [],
      aiTriage: {
        aiTriageStatus: 'skipped_deterministic',
        aiTriageReason: 'All failures were classified deterministically',
        aiEligibleFailures: 0,
        deterministicVerdicts: 1,
      },
    });
    const report = JSON.parse(fs.readFileSync(generated.path, 'utf-8'));

    assert.equal(report.aiSummary, null);
    assert.equal(report.metadata.aiTriage.aiTriageStatus, 'skipped_deterministic');
    assert.equal(report.aiTriage.deterministicVerdicts, 1);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
