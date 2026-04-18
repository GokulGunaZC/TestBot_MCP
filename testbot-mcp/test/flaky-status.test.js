'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PlaywrightIntegration = require('../src/playwright-integration');
const ResultsMerger = require('../src/results-merger');

// Build a minimal Playwright JSON reporter-shaped result file and feed it
// through parseTestResults to verify flaky detection + retry plumbing.
function writeReport(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-pw-json-'));
  const reportsDir = path.join(dir, 'healix-reports', 'results');
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = path.join(reportsDir, 'results.json');
  fs.writeFileSync(out, JSON.stringify(config), 'utf-8');
  return { projectPath: dir, resultFile: out };
}

function suiteWithSpec(specs) {
  return {
    suites: [{ title: 'generated', specs }],
  };
}

test('playwright-integration marks retried-then-passed tests as flaky', () => {
  const report = suiteWithSpec([{
    title: 'user can log in',
    file: 'tests/generated/login.spec.ts',
    tests: [{
      projectName: 'tierA-public',
      status: 'flaky',
      results: [
        { status: 'failed', duration: 800, error: { message: 'timeout waiting for button' } },
        { status: 'passed', duration: 400 },
      ],
    }],
  }]);

  const { projectPath } = writeReport(report);
  const pi = new PlaywrightIntegration({ projectPath });
  const parsed = pi.parseTestResults({ stdout: '', stderr: '', configPath: null, commandStartedAt: Date.now() });

  assert.equal(parsed.total, 1);
  assert.equal(parsed.flaky, 1, 'flaky counter increments');
  assert.equal(parsed.passed, 1, 'passed counter still increments (headline pass rate intact)');
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.tests[0].status, 'flaky');
  assert.equal(parsed.tests[0].retries, 1, 'one retry recorded');
});

test('playwright-integration detects flakiness even without test.status=flaky', () => {
  const report = suiteWithSpec([{
    title: 'cart interaction',
    file: 'tests/generated/cart.spec.ts',
    tests: [{
      projectName: 'tierA-public',
      // Playwright versions vary: sometimes test-level status isn't "flaky"
      status: 'unexpected',
      results: [
        { status: 'failed', duration: 1000 },
        { status: 'failed', duration: 900 },
        { status: 'passed', duration: 500 },
      ],
    }],
  }]);
  const { projectPath } = writeReport(report);
  const pi = new PlaywrightIntegration({ projectPath });
  const parsed = pi.parseTestResults({ stdout: '', stderr: '', configPath: null, commandStartedAt: Date.now() });
  assert.equal(parsed.flaky, 1);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.tests[0].status, 'flaky');
  assert.equal(parsed.tests[0].retries, 2);
});

test('playwright-integration treats all-failed retries as failed (not flaky)', () => {
  const report = suiteWithSpec([{
    title: 'broken test',
    file: 'tests/generated/broken.spec.ts',
    tests: [{
      projectName: 'tierA-public',
      status: 'unexpected',
      results: [
        { status: 'failed', duration: 1000, error: { message: 'broken' } },
        { status: 'failed', duration: 1000, error: { message: 'still broken' } },
        { status: 'failed', duration: 1000, error: { message: 'still broken' } },
      ],
    }],
  }]);
  const { projectPath } = writeReport(report);
  const pi = new PlaywrightIntegration({ projectPath });
  const parsed = pi.parseTestResults({ stdout: '', stderr: '', configPath: null, commandStartedAt: Date.now() });
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.flaky, 0);
  assert.equal(parsed.tests[0].status, 'failed');
  assert.equal(parsed.tests[0].retries, 2);
});

test('results-merger preserves flaky across direct+mcp merge and counts separately', () => {
  const merger = new ResultsMerger();
  const direct = {
    total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0,
    tests: [
      { id: 'a', title: 'A', file: 'a.spec.ts', status: 'passed', duration: 100, projectName: 'tierA-public' },
      { id: 'b', title: 'B', file: 'b.spec.ts', status: 'failed', duration: 100, projectName: 'tierA-public' },
    ],
  };
  const mcp = {
    total: 2, passed: 2, failed: 0, skipped: 0, flaky: 1,
    tests: [
      { id: 'a', title: 'A', file: 'a.spec.ts', status: 'passed', duration: 100, projectName: 'tierA-public' },
      { id: 'b', title: 'B', file: 'b.spec.ts', status: 'flaky', duration: 100, projectName: 'tierA-public' },
    ],
  };

  const merged = merger.mergeResults(direct, mcp);
  assert.equal(merged.total, 2);
  // b was failed in direct but flaky in mcp — getWorstStatus prefers failed > flaky,
  // so merged.b is 'failed' and the failed counter wins.
  assert.equal(merged.failed, 1);
  assert.equal(merged.flaky, 0);
});

test('results-merger computeTierResults tracks flaky per tier', () => {
  const merger = new ResultsMerger();
  const tests = [
    { status: 'passed', projectName: 'tierA-public' },
    { status: 'flaky', projectName: 'tierA-public' },
    { status: 'failed', projectName: 'tierB-auth-admin' },
    { status: 'passed', projectName: 'tierB-auth-admin' },
    { status: 'skipped', projectName: 'tierC-backend' },
  ];
  const tiers = merger.computeTierResults(tests);
  assert.equal(tiers['A-public'].flaky, 1);
  assert.equal(tiers['A-public'].passed, 1);
  assert.equal(tiers['B-auth-admin'].failed, 1);
  assert.equal(tiers['B-auth-admin'].passed, 1);
  assert.equal(tiers['C-backend'].skipped, 1);
});
