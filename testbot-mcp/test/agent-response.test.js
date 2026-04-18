'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAgentResponse,
  verifyPatchAgainstDisk,
  autoApplyKillSwitchOn,
  AUTO_APPLY_CONFIDENCE_FLOOR,
} = require('../src/failure-triage/agent-response');

function tmpProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-agent-resp-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// ── Guardrail ────────────────────────────────────────────────────────────

test('verifyPatchAgainstDisk passes a clean [REQ:]-preserving patch', () => {
  const source = `test('[REQ:F1.S1.AC1] button label', async ({ page }) => {\n  await page.getByRole('button', { name: 'Buy now' }).click();\n  expect(page.url()).toContain('/order');\n});`;
  const patch = {
    oldCode: `page.getByRole('button', { name: 'Buy now' })`,
    newCode: `page.getByRole('button', { name: 'Place order' })`,
  };
  const result = verifyPatchAgainstDisk({ patch, testSource: source });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verified');
});

test('verifyPatchAgainstDisk rejects when oldCode is not present on disk', () => {
  const source = `test('[REQ:F1.S1.AC1] x', () => { expect(1).toBe(1); });`;
  const patch = { oldCode: 'ghost_string', newCode: 'expect(2).toBe(2);' };
  const result = verifyPatchAgainstDisk({ patch, testSource: source });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'oldCode_not_in_source');
});

test('verifyPatchAgainstDisk rejects a patch that removes the [REQ:] tag', () => {
  const source = `test('[REQ:F1.S1.AC1] x', () => { expect(1).toBe(1); });`;
  const patch = {
    oldCode: `test('[REQ:F1.S1.AC1] x', () => { expect(1).toBe(1); });`,
    newCode: `test('x', () => { expect(1).toBe(1); });`,
  };
  const result = verifyPatchAgainstDisk({ patch, testSource: source });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'requirement_tag_removed');
});

test('verifyPatchAgainstDisk rejects a patch that removes every expect()', () => {
  const source = `test('[REQ:F1.S1.AC1] x', () => { expect(1).toBe(1); });`;
  const patch = {
    oldCode: `expect(1).toBe(1);`,
    newCode: `// weakened`,
  };
  const result = verifyPatchAgainstDisk({ patch, testSource: source });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_expect_call_remaining');
});

test('verifyPatchAgainstDisk returns test_source_unavailable when file missing', () => {
  const result = verifyPatchAgainstDisk({
    patch: { oldCode: 'a', newCode: 'b' },
    testSource: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'test_source_unavailable');
});

// ── Kill switch ──────────────────────────────────────────────────────────

test('autoApplyKillSwitchOn honours HEALIX_AUTO_APPLY_TEST_PATCHES=false', () => {
  const prev = process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;
  process.env.HEALIX_AUTO_APPLY_TEST_PATCHES = 'false';
  assert.equal(autoApplyKillSwitchOn(), true);
  process.env.HEALIX_AUTO_APPLY_TEST_PATCHES = '0';
  assert.equal(autoApplyKillSwitchOn(), true);
  process.env.HEALIX_AUTO_APPLY_TEST_PATCHES = '';
  assert.equal(autoApplyKillSwitchOn(), false);
  if (prev === undefined) delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;
  else process.env.HEALIX_AUTO_APPLY_TEST_PATCHES = prev;
});

// ── Bucketing ────────────────────────────────────────────────────────────

const AC_TAG = '[REQ:F1.S1.AC1]';

function makeBundle(over = {}) {
  return {
    kind: 'test',
    testName: `${AC_TAG} user can do a thing`,
    file: 'tests/generated/thing.spec.ts',
    tier: 'tiera-public',
    trace: { failedAction: { name: 'click', selector: '#x', url: '/page', errorText: 'resolved to 0 elements' } },
    testSource: `test('${AC_TAG} user can do a thing', async ({ page }) => {\n  await page.click('#old-sel');\n  expect(page.url()).toContain('/page');\n});`,
    ...over,
  };
}

function baseReport(bundles, verdicts) {
  return {
    stats: { total: bundles.length, passed: 0, failed: bundles.length, skipped: 0, flaky: 0 },
    failures: bundles,
    classifierVerdicts: verdicts,
    failureClusters: [],
  };
}

test('buildAgentResponse auto-applies test_is_wrong when conf ≥ 0.85 and guardrail ok', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'test_is_wrong', confidence: 0.92, reason: 'hallucinated_selector' };
  const report = baseReport([bundle], [verdict]);
  const ai = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.92,
    reason: 'hallucinated_selector',
    suggestedPatch: {
      file: bundle.file,
      lineStart: 2,
      lineEnd: 2,
      oldCode: `await page.click('#old-sel');`,
      newCode: `await page.click('#new-sel');`,
    },
  }];

  delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;
  const resp = buildAgentResponse({ report, aiAnalysis: ai, dashboardUrl: 'https://dash', testRunId: 'run-1' });

  assert.equal(resp.verdicts.auto_apply.length, 1);
  assert.equal(resp.verdicts.auto_apply[0].patch.newCode, `await page.click('#new-sel');`);
  assert.equal(resp.verdicts.surface_for_approval.length, 0);
  assert.match(resp.actionPlan, /Auto-apply/);
  assert.equal(resp.dashboardUrl, 'https://dash/test-run/run-1');
});

test('buildAgentResponse downgrades to surface_for_approval when patch fails guardrail', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'test_is_wrong', confidence: 0.95, reason: 'hallucinated_selector' };
  const report = baseReport([bundle], [verdict]);
  const ai = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.95,
    reason: 'hallucinated_selector',
    suggestedPatch: {
      file: bundle.file,
      // oldCode not in source → fails guardrail
      oldCode: `await page.click('#does-not-exist');`,
      newCode: `await page.click('#new');`,
    },
  }];
  delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;

  const resp = buildAgentResponse({ report, aiAnalysis: ai });
  assert.equal(resp.verdicts.auto_apply.length, 0);
  assert.equal(resp.verdicts.surface_for_approval.length, 1);
  assert.equal(resp.verdicts.surface_for_approval[0].downgradeReason, 'oldCode_not_in_source');
});

test('buildAgentResponse downgrades when confidence is below floor', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'test_is_wrong', confidence: 0.70, reason: 'maybe_test_wrong' };
  const ai = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.70,
    reason: 'maybe_test_wrong',
    suggestedPatch: {
      file: bundle.file,
      oldCode: `await page.click('#old-sel');`,
      newCode: `await page.click('#new-sel');`,
    },
  }];
  const report = baseReport([bundle], [verdict]);
  delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;

  const resp = buildAgentResponse({ report, aiAnalysis: ai });
  assert.equal(resp.verdicts.auto_apply.length, 0);
  assert.equal(resp.verdicts.surface_for_approval.length, 1);
  assert.equal(resp.verdicts.surface_for_approval[0].downgradeReason, 'confidence_below_floor');
  assert.ok(AUTO_APPLY_CONFIDENCE_FLOOR === 0.85);
});

test('buildAgentResponse routes app_is_wrong into app_regressions and never auto-applies', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'app_is_wrong', confidence: 0.9, reason: 'server_error_500' };
  const ai = [{
    testName: bundle.testName,
    verdict: 'app_is_wrong',
    verdictConfidence: 0.9,
    reason: 'server_error_500',
    suggestedPatch: null,
  }];
  const report = baseReport([bundle], [verdict]);

  const resp = buildAgentResponse({ report, aiAnalysis: ai });
  assert.equal(resp.verdicts.auto_apply.length, 0);
  assert.equal(resp.verdicts.app_regressions.length, 1);
  assert.equal(resp.verdicts.app_regressions[0].reason, 'server_error_500');
});

test('buildAgentResponse routes environment verdict into environment_issues', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'environment', confidence: 0.9, reason: 'server_unreachable' };
  const report = baseReport([bundle], [verdict]);

  const resp = buildAgentResponse({ report });
  assert.equal(resp.verdicts.environment_issues.length, 1);
  assert.equal(resp.verdicts.environment_issues[0].reason, 'server_unreachable');
});

test('kill switch forces every test_is_wrong into surface_for_approval', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'test_is_wrong', confidence: 0.98, reason: 'hallucinated_selector' };
  const ai = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.98,
    reason: 'hallucinated_selector',
    suggestedPatch: {
      file: bundle.file,
      oldCode: `await page.click('#old-sel');`,
      newCode: `await page.click('#new-sel');`,
    },
  }];
  const report = baseReport([bundle], [verdict]);

  process.env.HEALIX_AUTO_APPLY_TEST_PATCHES = 'false';
  try {
    const resp = buildAgentResponse({ report, aiAnalysis: ai });
    assert.equal(resp.verdicts.auto_apply.length, 0);
    assert.equal(resp.verdicts.surface_for_approval.length, 1);
    assert.equal(resp.verdicts.surface_for_approval[0].downgradeReason, 'kill_switch');
  } finally {
    delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;
  }
});

test('buildAgentResponse surfaces pipeline_error when the report has one', () => {
  const report = {
    stats: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
    failures: [],
    classifierVerdicts: [],
    failureClusters: [],
    pipelineError: {
      stage: 'validation',
      reason: 'playwright_list_failed',
      stderr: 'missing dependency @playwright/test',
      generatedSpecCount: 4,
      userFacingMessage: 'Install @playwright/test.',
    },
  };
  const resp = buildAgentResponse({ report, dashboardUrl: 'https://dash', testRunId: 'r1' });
  assert.ok(resp.verdicts.pipeline_error);
  assert.equal(resp.verdicts.pipeline_error.stage, 'validation');
  assert.equal(resp.verdicts.pipeline_error.reason, 'playwright_list_failed');
  assert.match(resp.verdicts.pipeline_error.stderrPreview, /missing dependency/);
  assert.match(resp.actionPlan, /Pipeline error/);
});

test('buildAgentResponse re-reads test source from disk when bundle.testSource is absent', () => {
  const root = tmpProject({
    'tests/generated/thing.spec.ts': `test('${AC_TAG} user can do a thing', async ({ page }) => {\n  await page.click('#old-sel');\n  expect(page.url()).toContain('/page');\n});`,
  });
  const bundle = { ...makeBundle(), testSource: undefined };
  const verdict = { verdict: 'test_is_wrong', confidence: 0.92, reason: 'hallucinated_selector' };
  const ai = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.92,
    reason: 'hallucinated_selector',
    suggestedPatch: {
      file: bundle.file,
      oldCode: `await page.click('#old-sel');`,
      newCode: `await page.click('#new-sel');`,
    },
  }];
  const report = baseReport([bundle], [verdict]);

  delete process.env.HEALIX_AUTO_APPLY_TEST_PATCHES;
  const resp = buildAgentResponse({ report, projectPath: root, aiAnalysis: ai });
  assert.equal(resp.verdicts.auto_apply.length, 1, 'disk-read should let the patch verify');
});

test('action plan string lists dashboard deep links for items that have them', () => {
  const bundle = makeBundle();
  const verdict = { verdict: 'app_is_wrong', confidence: 0.9, reason: 'server_error_500' };
  const ai = [{ testName: bundle.testName, verdict: 'app_is_wrong', verdictConfidence: 0.9, reason: 'server_error_500' }];
  const report = baseReport([bundle], [verdict]);

  const resp = buildAgentResponse({ report, dashboardUrl: 'https://dash', testRunId: 'run-42', aiAnalysis: ai });
  assert.match(resp.actionPlan, /https:\/\/dash\/test-run\/run-42/);
});
