const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRouteAccessSummary,
  buildGenerationRepairContext,
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
  maybeExpandGenerationStageBudget,
  isRepairableGenerationFailure,
  isBrittleGeneratedTestBlock,
  isSyntheticHealthEndpoint,
  pickAgentsForRun,
  pruneGeneratedTestsByQuality,
  quarantineGeneratedSpecFiles,
  resolveGenerationAgentConcurrency,
  rewriteStartCommandForPort,
} = require('../src/pipeline-worker');

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
