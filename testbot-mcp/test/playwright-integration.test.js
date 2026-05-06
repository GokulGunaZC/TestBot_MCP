const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PlaywrightIntegration = require('../src/playwright-integration');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-playwright-'));
  fs.mkdirSync(path.join(root, 'tests', 'generated'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'generated', 'smoke.spec.ts'),
    "import { test } from '@playwright/test'; test('smoke', async () => {});",
    'utf-8',
  );
  return root;
}

test('playwright crash classifier retries runner crashes without parseable results', () => {
  const root = makeProject();
  try {
    const integration = new PlaywrightIntegration({ projectPath: root });
    const classification = integration.classifyPlaywrightExecutionCrash({
      commandResult: {
        code: 1,
        stderr: 'Target page, context or browser has been closed\nworker process exited unexpectedly',
        stdout: '',
      },
      testResults: { total: 0, failed: 0, failures: [], tests: [] },
    });

    assert.equal(classification.infrastructure, true);
    assert.equal(classification.retryable, true);
    assert.equal(classification.reason, 'browser_crash_no_results');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('playwright crash classifier does not retry no-test or loader errors', () => {
  const root = makeProject();
  try {
    const integration = new PlaywrightIntegration({ projectPath: root });
    assert.deepEqual(integration.classifyPlaywrightExecutionCrash({
      commandResult: { code: 1, stderr: 'Error: No tests found', stdout: '' },
      testResults: { total: 0, failed: 0, failures: [], tests: [] },
    }), { infrastructure: false, retryable: false, reason: 'no_tests' });

    assert.deepEqual(integration.classifyPlaywrightExecutionCrash({
      commandResult: { code: 1, stderr: 'SyntaxError: Unexpected token }', stdout: '' },
      testResults: { total: 0, failed: 0, failures: [], tests: [] },
    }), { infrastructure: false, retryable: false, reason: 'load_error' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('playwright crash classifier leaves real assertion failures as test results', () => {
  const root = makeProject();
  try {
    const integration = new PlaywrightIntegration({ projectPath: root });
    const classification = integration.classifyPlaywrightExecutionCrash({
      commandResult: { code: 1, stderr: '', stdout: '1 failed' },
      testResults: {
        total: 1,
        failed: 1,
        failures: [{
          testName: 'shows project title',
          error: { message: "Error: expect(locator).toHaveText('Projects')" },
        }],
        tests: [],
      },
    });

    assert.equal(classification.infrastructure, false);
    assert.equal(classification.retryable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('playwright crash classifier retries partial browser-close failures', () => {
  const root = makeProject();
  try {
    const integration = new PlaywrightIntegration({ projectPath: root });
    const classification = integration.classifyPlaywrightExecutionCrash({
      commandResult: { code: 1, stderr: '', stdout: '1 failed' },
      testResults: {
        total: 1,
        failed: 1,
        failures: [{
          testName: 'calendar navigation',
          error: { message: 'Error: Target page, context or browser has been closed' },
        }],
        tests: [],
      },
    });

    assert.equal(classification.infrastructure, true);
    assert.equal(classification.retryable, true);
    assert.equal(classification.reason, 'browser_crash_with_results');
    assert.equal(classification.allKnownFailuresAreInfrastructure, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('playwright crash retry args force single-worker safe mode without duplicates', () => {
  const integration = new PlaywrightIntegration({ projectPath: process.cwd() });
  assert.deepEqual(
    integration.buildCrashRetryArgs(['playwright', 'test', '--config', 'playwright.config.ts']),
    ['playwright', 'test', '--config', 'playwright.config.ts', '--workers', '1', '--retries', '1'],
  );
  assert.deepEqual(
    integration.buildCrashRetryArgs(['playwright', 'test', '--workers=2', '--retries=2']),
    ['playwright', 'test', '--workers=1', '--retries=2'],
  );
  assert.deepEqual(
    integration.buildCrashRetryArgs(['playwright', 'test', '--workers', '3']),
    ['playwright', 'test', '--workers', '1', '--retries', '1'],
  );
});

test('runtime config includes Playwright safe-retry overrides', () => {
  const root = makeProject();
  try {
    fs.writeFileSync(
      path.join(root, 'playwright.config.ts'),
      "import { defineConfig } from '@playwright/test'; export default defineConfig({ reporter: [['list']] });",
      'utf-8',
    );
    const integration = new PlaywrightIntegration({ projectPath: root, baseURL: 'http://localhost:5173' });
    const runtimeConfigPath = integration.ensureRuntimePlaywrightConfig(path.join(root, 'playwright.config.ts'));
    const content = fs.readFileSync(runtimeConfigPath, 'utf-8');

    assert.match(content, /HEALIX_PLAYWRIGHT_SAFE_RETRY/);
    assert.match(content, /workers:\s*1/);
    assert.match(content, /video:\s*'off'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
