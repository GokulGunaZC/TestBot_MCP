'use strict';

/**
 * End-to-end integration test for the Healix pipeline against a mock app.
 *
 *   1. Boot mock-app (real HTTP server with mock session auth).
 *   2. Run the exploration phase — verify it discovers routes + login form.
 *   3. Run the credentials injector for two roles + one bad-creds role —
 *      verify storageState files are written for the valid ones and the bad
 *      one is cleanly marked loginVerified:false.
 *   4. Emit a tier-aware Playwright config via the pipeline's helper, and
 *      drop a hand-written tierB spec that hits /admin and /dashboard using
 *      the injected storageState.
 *   5. Run Playwright against the generated suite — verify:
 *        - tierA-public passes (public routes)
 *        - tierB-auth-admin passes (admin sees /admin)
 *        - tierB-auth-user fails closed on /admin (403) — verifying the
 *          role-segmentation actually works
 *        - tierC-backend passes (API contract via request context)
 *
 *  Skipped automatically if playwright isn't installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { start: startMockApp } = require('./fixtures/mock-app');
const { runExplorationPhase } = require('../src/exploration-phase');
const { injectCredentials } = require('../src/credentials-injector');

let playwrightAvailable = true;
try { require('playwright'); require('@playwright/test'); } catch { playwrightAvailable = false; }

function tmpProject(name) {
  // Put the tmp project INSIDE testbot-mcp so Node's native module resolution
  // picks up @playwright/test + playwright-core from the package's own
  // node_modules. Bridging via symlink proved flaky — workers' chromium
  // processes couldn't reach the HTTP server.
  const rootTmp = path.join(__dirname, 'tmp');
  fs.mkdirSync(rootTmp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(rootTmp, `pipe-${name}-`));
  fs.mkdirSync(path.join(dir, 'tests', 'generated'), { recursive: true });
  return dir;
}

async function cleanup(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writePlaywrightConfig(projectPath, baseURL, roles) {
  const verifiedRoles = roles.filter((r) => r.loginVerified && r.storageStatePath);
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${r.role}',
      grep: /@auth|@tierB/,
      use: { ...devices['Desktop Chrome'], storageState: ${JSON.stringify(r.storageStatePath)} },
    }`).join(',\n');
  const projects = [
    `    { name: 'tierA-public', grepInvert: /@auth|@tierB|@api|@tierC/, use: { ...devices['Desktop Chrome'] } }`,
    tierBProjects,
    `    { name: 'tierC-backend', grep: /@api|@tierC/, use: { ...devices['Desktop Chrome'] } }`,
  ].filter(Boolean).join(',\n');

  const config = `const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/generated',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: 'healix-reports/results/results.json' }], ['list']],
  use: { baseURL: ${JSON.stringify(baseURL)}, trace: 'off', actionTimeout: 10000, navigationTimeout: 15000 },
  projects: [
${projects}
  ],
});
`;
  fs.writeFileSync(path.join(projectPath, 'playwright.config.js'), config, 'utf-8');
}

function writeTierSpecs(projectPath) {
  const dir = path.join(projectPath, 'tests', 'generated');
  fs.writeFileSync(path.join(dir, 'home.spec.js'),
    `const { test, expect } = require('@playwright/test');
test('home page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Welcome');
});`);

  fs.writeFileSync(path.join(dir, 'dashboard.spec.js'),
    `const { test, expect } = require('@playwright/test');
test('authenticated user sees dashboard @auth', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('[data-testid="welcome"]')).toBeVisible();
});
test('admin can reach /admin @auth', async ({ page }) => {
  await page.goto('/admin');
  const heading = page.locator('[data-testid="admin-title"]');
  await expect(heading).toBeVisible();
});`);

  fs.writeFileSync(path.join(dir, 'api.spec.js'),
    `const { test, expect } = require('@playwright/test');
test('public health endpoint @api', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});`);
}

test('pipeline end-to-end against mock app', async (t) => {
  if (!playwrightAvailable) {
    t.skip('playwright not installed');
    return;
  }

  const app = await startMockApp({ logRequests: process.env.HEALIX_PIPELINE_TEST_DEBUG === '1' });
  // Sanity-check the server is reachable from the test process before spending
  // Playwright cycles on a dead port.
  const sanity = await fetch(app.baseURL + '/').then((r) => r.status).catch((e) => `ERR:${e.message}`);
  console.log('[pipeline-integration] mock app @', app.baseURL, 'sanity GET / =>', sanity);
  const projectPath = tmpProject('e2e');
  t.after(async () => {
    await app.stop();
    await cleanup(projectPath);
  });

  // ------------------------------------------------------------------------
  // 1. Exploration — should find routes + login form + authFlow
  // ------------------------------------------------------------------------
  const exploration = await runExplorationPhase({
    statusDir: null,
    baseURL: app.baseURL,
    credentials: [{ role: 'user', username: 'user@example.com', password: 'user123' }],
    totalTimeoutMs: 60_000,
  });
  assert.ok(
    exploration.source === 'browser-use' || exploration.source === 'playwright-heuristic',
    `expected exploration to succeed, got source=${exploration.source} reason=${exploration.reason || 'n/a'}`
  );
  const paths = exploration.artifact.routes.map((r) => r.path);
  assert.ok(paths.includes('/') || paths.includes('/login'), `expected home or login in routes, got ${paths.join(',')}`);
  assert.ok(exploration.artifact.authFlow, 'expected authFlow to be populated from the login form');
  assert.ok(
    exploration.artifact.authFlow.credentialFields.password,
    'expected authFlow to include a password selector'
  );

  // ------------------------------------------------------------------------
  // 2. Credential injection — valid creds succeed, bad creds cleanly fail
  // ------------------------------------------------------------------------
  const roles = await injectCredentials({
    projectPath,
    baseURL: app.baseURL,
    credentials: [
      { role: 'admin', username: 'admin@example.com', password: 'admin123' },
      { role: 'user', username: 'user@example.com', password: 'user123' },
      { role: 'bogus', username: 'ghost@example.com', password: 'wrong' },
    ],
    authFlow: {
      loginUrl: '/login',
      credentialFields: {
        username: 'input[type="email"]',
        password: 'input[type="password"]',
      },
      // The mock redirects to /dashboard on success; this element is only on
      // that page, so Playwright seeing it post-submit means login worked.
      successIndicator: '[data-testid="welcome"]',
      failureIndicator: '[data-testid="login-error"]',
    },
  });

  const adminRole = roles.find((r) => r.role === 'admin');
  const userRole = roles.find((r) => r.role === 'user');
  const bogusRole = roles.find((r) => r.role === 'bogus');
  assert.ok(adminRole?.loginVerified, `admin login should verify: ${adminRole?.reason || ''}`);
  assert.ok(userRole?.loginVerified, `user login should verify: ${userRole?.reason || ''}`);
  assert.equal(bogusRole?.loginVerified, false, 'bogus login should fail cleanly');
  assert.ok(fs.existsSync(adminRole.storageStatePath), 'admin storageState file should exist');
  assert.ok(fs.existsSync(userRole.storageStatePath), 'user storageState file should exist');
  // Storage state must contain a session cookie.
  const adminState = JSON.parse(fs.readFileSync(adminRole.storageStatePath, 'utf-8'));
  const hasSession = (adminState.cookies || []).some((c) => c.name === 'session' && c.value === 'admin');
  assert.ok(hasSession, 'admin storageState should carry the session=admin cookie');

  // ------------------------------------------------------------------------
  // 3. Emit tier-aware playwright config + specs
  // ------------------------------------------------------------------------
  writePlaywrightConfig(projectPath, app.baseURL, roles);
  writeTierSpecs(projectPath);

  // No bridging needed — we're inside testbot-mcp/test/tmp so Node walks up
  // to testbot-mcp/node_modules and finds @playwright/test + playwright-core
  // natively.

  // ------------------------------------------------------------------------
  // 4. Run Playwright — tiers should execute independently
  // ------------------------------------------------------------------------
  const cli = require.resolve('@playwright/test/cli');
  // Must use async spawn: the mock HTTP server runs in this process's event
  // loop. spawnSync would block it and Playwright workers would time out
  // trying to connect.
  const run = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [cli, 'test'], {
      cwd: projectPath,
      env: { ...process.env, CI: '1' },
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on('data', (c) => stdoutChunks.push(c));
    proc.stderr.on('data', (c) => stderrChunks.push(c));
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 180_000);
    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        status: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });

  const resultsPath = path.join(projectPath, 'healix-reports', 'results', 'results.json');
  if (!fs.existsSync(resultsPath) || process.env.HEALIX_PIPELINE_TEST_DEBUG === '1') {
    console.log('[pipeline-integration] playwright stdout:\n', run.stdout?.slice(0, 4000) || '(none)');
    console.log('[pipeline-integration] playwright stderr:\n', run.stderr?.slice(0, 4000) || '(none)');
    console.log('[pipeline-integration] playwright exit:', run.status, 'signal:', run.signal);
  }
  assert.ok(fs.existsSync(resultsPath), `expected results.json at ${resultsPath}. stderr: ${run.stderr?.slice(0, 2000)}`);
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

  // Flatten into { projectName, title, status }
  const outcomes = [];
  for (const suite of results.suites || []) {
    for (const spec of suite.specs || []) {
      for (const testObj of spec.tests || []) {
        outcomes.push({
          project: testObj.projectName,
          title: spec.title,
          status: testObj.status || (testObj.results && testObj.results[0]?.status) || 'unknown',
        });
      }
    }
    for (const sub of suite.suites || []) {
      for (const spec of sub.specs || []) {
        for (const testObj of spec.tests || []) {
          outcomes.push({
            project: testObj.projectName,
            title: spec.title,
            status: testObj.status || (testObj.results && testObj.results[0]?.status) || 'unknown',
          });
        }
      }
    }
  }

  // Expectations per project:
  const tierA = outcomes.filter((o) => o.project === 'tierA-public');
  const tierBAdmin = outcomes.filter((o) => o.project === 'tierB-auth-admin');
  const tierBUser = outcomes.filter((o) => o.project === 'tierB-auth-user');
  const tierC = outcomes.filter((o) => o.project === 'tierC-backend');

  // tierA-public must include the home test, and it must pass.
  const homeInA = tierA.find((o) => o.title.includes('home page loads'));
  assert.ok(homeInA, `tierA-public missing 'home page loads'. outcomes=${JSON.stringify(outcomes)}`);
  assert.equal(homeInA.status, 'expected', `home page test should pass in tierA: ${homeInA.status}`);

  // tierB-auth-admin must run the dashboard tests and pass both.
  const adminDashboard = tierBAdmin.find((o) => o.title.includes('sees dashboard'));
  const adminOnAdmin = tierBAdmin.find((o) => o.title.includes('admin can reach'));
  assert.ok(adminDashboard && adminOnAdmin, `tierB-auth-admin missing dashboard tests: ${JSON.stringify(tierBAdmin)}`);
  assert.equal(adminDashboard.status, 'expected', 'admin dashboard test should pass');
  assert.equal(adminOnAdmin.status, 'expected', 'admin /admin test should pass');

  // tierB-auth-user must FAIL on /admin (role-segmentation works).
  const userOnAdmin = tierBUser.find((o) => o.title.includes('admin can reach'));
  const userOnDashboard = tierBUser.find((o) => o.title.includes('sees dashboard'));
  assert.ok(userOnAdmin, `tierB-auth-user missing '/admin' test: ${JSON.stringify(tierBUser)}`);
  assert.equal(userOnDashboard.status, 'expected', 'user dashboard test should pass');
  assert.notEqual(userOnAdmin.status, 'expected',
    'user should be blocked from /admin — verifying role segmentation in Tier B'
  );

  // tierC-backend must run the API test and pass.
  const apiHealth = tierC.find((o) => o.title.includes('public health endpoint'));
  assert.ok(apiHealth, `tierC-backend missing '/api/health': ${JSON.stringify(tierC)}`);
  assert.equal(apiHealth.status, 'expected', 'tierC /api/health should pass');

  // Summary for humans reading the logs.
  console.log('\n[pipeline-integration] tier results:');
  for (const [name, group] of [['tierA-public', tierA], ['tierB-auth-admin', tierBAdmin], ['tierB-auth-user', tierBUser], ['tierC-backend', tierC]]) {
    const pass = group.filter((o) => o.status === 'expected').length;
    console.log(`  ${name}: ${pass}/${group.length} passed`);
  }
});
