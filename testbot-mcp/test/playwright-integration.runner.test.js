const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PlaywrightIntegration = require('../src/playwright-integration');

test('buildRunnerInvocation resolves Playwright test CLI without relying on cli.js export path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-playwright-cli-'));

  try {
    const integration = new PlaywrightIntegration({
      projectPath: tempDir,
      baseURL: 'http://localhost:3000',
    });
    const invocation = integration.buildRunnerInvocation(['playwright', '--version']);

    assert.equal(invocation.command, process.execPath);
    assert.ok(
      invocation.args.some((arg) => String(arg).endsWith('@playwright/test/cli.js')),
      `expected resolved cli path in args, got: ${JSON.stringify(invocation.args)}`
    );
    assert.ok(
      fs.existsSync(path.join(tempDir, 'node_modules', '@playwright', 'test')),
      'expected project bridge for @playwright/test to exist'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runPlaywrightCommand can list generated tests in project without local @playwright/test', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-playwright-list-'));
  fs.mkdirSync(path.join(tempDir, 'tests', 'generated'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'tests', 'generated', 'sample.spec.ts'),
    [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('sample smoke', async () => {",
      '  expect(1).toBe(1);',
      '});',
      '',
    ].join('\n')
  );

  try {
    const integration = new PlaywrightIntegration({
      projectPath: tempDir,
      baseURL: 'http://localhost:3000',
    });

    const result = await integration.runPlaywrightCommand(
      ['playwright', 'test', 'tests/generated', '--list'],
      60000
    );

    assert.equal(result.code, 0);
    assert.match(String(result.stdout || ''), /sample smoke/i);
    assert.doesNotMatch(String(result.stderr || ''), /unknown command/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
