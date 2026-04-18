'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ReportGenerator = require('../src/report-generator');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'healix-report-'));
}

test('report-generator includes failures[] and stats.flaky in the written report', async () => {
  const projectPath = tmpProject();
  const reportGen = new ReportGenerator();

  const bundles = [
    {
      kind: 'test',
      testName: '[REQ:F1.S1.AC1] user can log in',
      file: 'tests/generated/login.spec.ts',
      tier: 'tiera-public',
      role: null,
      error: { message: 'timeout' },
      trace: { parseError: 'trace_not_available' },
    },
  ];

  const result = await reportGen.generate({
    projectPath,
    projectName: 'demo',
    runId: 'run-abc',
    testResults: {
      total: 3, passed: 2, failed: 1, skipped: 0, flaky: 1, duration: 1000, tests: [], failures: [],
    },
    failures: bundles,
    flakyCount: 1,
  });

  assert.ok(result.path, 'returned report path');
  const written = JSON.parse(fs.readFileSync(result.path, 'utf-8'));

  assert.equal(written.stats.flaky, 1, 'stats.flaky populated');
  assert.equal(written.stats.passed, 2);
  assert.equal(written.stats.failed, 1);
  assert.ok(Array.isArray(written.failures), 'failures array present');
  assert.equal(written.failures.length, 1);
  assert.equal(written.failures[0].testName, '[REQ:F1.S1.AC1] user can log in');
  assert.equal(written.failures[0].tier, 'tiera-public');
});

test('report-generator defaults flaky=0 and failures=[] when omitted', async () => {
  const projectPath = tmpProject();
  const reportGen = new ReportGenerator();

  const result = await reportGen.generate({
    projectPath,
    projectName: 'demo',
    runId: 'run-xyz',
    testResults: {
      total: 1, passed: 1, failed: 0, skipped: 0, duration: 10, tests: [], failures: [],
    },
  });

  const written = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
  assert.equal(written.stats.flaky, 0);
  assert.deepEqual(written.failures, []);
});

test('report-generator persists classifierVerdicts and failureClusters', async () => {
  const projectPath = tmpProject();
  const reportGen = new ReportGenerator();

  const verdicts = [
    { verdict: 'test_is_wrong', confidence: 0.9, reason: 'hallucinated_selector', ruleId: 1, selectorKey: 'x', clusterId: 'cluster-1' },
    { verdict: 'test_is_wrong', confidence: 0.9, reason: 'hallucinated_selector', ruleId: 1, selectorKey: 'x', clusterId: 'cluster-1' },
    { verdict: 'test_is_wrong', confidence: 0.9, reason: 'hallucinated_selector', ruleId: 1, selectorKey: 'x', clusterId: 'cluster-1' },
  ];
  const clusters = [
    { clusterId: 'cluster-1', size: 3, tierWide: false, memberIndexes: [0, 1, 2], verdict: 'test_is_wrong', reason: 'hallucinated_selector', tier: 'tiera-public' },
  ];

  const result = await reportGen.generate({
    projectPath,
    projectName: 'demo',
    runId: 'run-cluster',
    testResults: {
      total: 3, passed: 0, failed: 3, skipped: 0, duration: 10, tests: [], failures: [],
    },
    classifierVerdicts: verdicts,
    failureClusters: clusters,
  });

  const written = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
  assert.equal(written.classifierVerdicts.length, 3);
  assert.equal(written.failureClusters.length, 1);
  assert.equal(written.failureClusters[0].clusterId, 'cluster-1');
});

test('report-generator POSTs failures + verdicts + clusters + flaky to /ingest', async () => {
  const projectPath = tmpProject();
  const reportGen = new ReportGenerator();

  let capturedBody = null;
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ test_run_id: 'test-run-123', dashboard_url: '/all-tests' }),
    };
  };

  try {
    await reportGen.generate({
      projectPath,
      projectName: 'demo',
      runId: 'run-with-ingest',
      testResults: { total: 3, passed: 1, failed: 1, skipped: 0, flaky: 1, duration: 1, tests: [], failures: [] },
      failures: [{ kind: 'test', testName: 'b', file: 'b.spec.ts', tier: 'tiera-public', error: { message: 'x' }, trace: { parseError: 'x' } }],
      classifierVerdicts: [{ verdict: 'test_is_wrong', confidence: 0.9, reason: 'hallucinated_selector', ruleId: 1 }],
      failureClusters: [{ clusterId: 'c-1', size: 3, tierWide: false, reason: 'hallucinated_selector' }],
      flakyCount: 1,
      api_key: 'fake-key-for-test',
      dashboard_url: 'http://fake.local',
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.ok(capturedBody, 'ingest body was captured');
  assert.ok(Array.isArray(capturedBody.failures), 'failures[] in body');
  assert.equal(capturedBody.failures.length, 1);
  assert.equal(capturedBody.failures[0].testName, 'b');
  assert.equal(capturedBody.flaky_count, 1);
  assert.ok(Array.isArray(capturedBody.classifier_verdicts));
  assert.equal(capturedBody.classifier_verdicts[0].verdict, 'test_is_wrong');
  assert.ok(Array.isArray(capturedBody.failure_clusters));
  assert.equal(capturedBody.failure_clusters[0].clusterId, 'c-1');
});

test('report-generator prefers explicit flakyCount over testResults.flaky', async () => {
  const projectPath = tmpProject();
  const reportGen = new ReportGenerator();

  const result = await reportGen.generate({
    projectPath,
    projectName: 'demo',
    runId: 'run-pq',
    testResults: {
      total: 2, passed: 2, failed: 0, skipped: 0, flaky: 99, duration: 10, tests: [], failures: [],
    },
    flakyCount: 2,
  });

  const written = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
  assert.equal(written.stats.flaky, 2);
});
