'use strict';

/**
 * Phase T8 — End-to-end triage verification.
 *
 * Exercises the full Healix v1.1 triage pipeline against scripted fixtures
 * that cover every scenario called out in the plan. For each fixture we:
 *
 *   1. Hand a bundle to the deterministic classifier (T3).
 *   2. Assemble a report-shaped object that matches what report-generator
 *      (T1/T2) would produce.
 *   3. Run it through buildAgentResponse (T7) and assert which bucket the
 *      failure lands in — auto_apply / surface_for_approval / app_regressions
 *      / environment_issues / pipeline_error.
 *
 * The six scenarios (from the plan's Phase T8 section):
 *   A. Hallucinated selector  → test_is_wrong, auto_apply with [REQ:] patch.
 *   B. Real app regression    → app_is_wrong, app_regressions, NOT auto_apply.
 *   C. Pipeline error         → verdicts.pipeline_error with stderr + remediation.
 *   D. Flake                  → results-merger counts flaky distinctly.
 *   E. Cluster                → classifier tags cluster_id, tier-wide penalty fires.
 *   F. User-override          → route validator accepts valid, rejects bad input.
 *
 * Scenarios A/B/C/E/F are pure-node unit tests; D pipes through
 * PlaywrightIntegration + ResultsMerger just like flaky-status.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentResponse, AUTO_APPLY_CONFIDENCE_FLOOR } = require('../src/failure-triage/agent-response');
const { classifyFailures, classifyOne } = require('../src/failure-triage/classifier');
const PlaywrightIntegration = require('../src/playwright-integration');
const ResultsMerger = require('../src/results-merger');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-t8-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  }
  return dir;
}

function hallucinatedBundle() {
  // Test asserts on a "Place order" button that exploration never saw; real
  // button says "Buy now". Classifier should flag test_is_wrong high conf.
  return {
    testName: 'checkout flow completes [REQ:F1.S1.AC1]',
    file: 'tests/generated/checkout.spec.ts',
    tier: 'tierA-public',
    trace: {
      failedAction: {
        name: 'expect.toBeVisible',
        selector: "role=button[name='Place order']",
        url: 'https://example.com/checkout',
        errorText: "locator.click: Timeout 30000ms exceeded.\nwaiting for locator getByRole('button', { name: 'Place order' })\nresolved to 0 elements",
      },
      networkAtFailure: [
        { url: '/api/cart', method: 'GET', status: 200, duration: 30 },
      ],
      consoleAtFailure: [],
      domAtFailure: { bodyTextSample: 'Buy now', visibleButtons: ['Buy now'], visibleInputs: [] },
    },
    error: { message: "Timeout 30000ms exceeded. resolved to 0 elements waiting for locator getByRole('button', { name: 'Place order' })" },
    explorationRoute: {
      url: '/checkout',
      selectors: ["role=button[name='Buy now']", 'input[name=email]'],
    },
    acceptanceCriterion: {
      id: 'F1.S1.AC1',
      text: 'User can place an order from the cart page.',
    },
    testSource: [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('checkout flow completes [REQ:F1.S1.AC1]', async ({ page }) => {",
      "  await page.goto('https://example.com/checkout');",
      "  await page.getByRole('button', { name: 'Place order' }).click();",
      "  await expect(page.getByText('Order placed')).toBeVisible();",
      "});",
      "",
    ].join('\n'),
  };
}

function realRegressionBundle() {
  // Checkout POST returns 500 on an app route the exploration DID find.
  return {
    testName: 'orders submit [REQ:F1.S2.AC1]',
    file: 'tests/generated/orders.spec.ts',
    tier: 'tierA-public',
    trace: {
      failedAction: {
        name: 'expect.toHaveURL',
        selector: "role=button[name='Submit']",
        url: 'https://example.com/orders',
        errorText: 'Expected page to navigate to /orders/confirmed, stayed on /orders.',
      },
      networkAtFailure: [
        { url: 'https://example.com/api/orders', method: 'POST', status: 500, duration: 120 },
        { url: 'https://example.com/api/cart', method: 'GET', status: 200, duration: 40 },
      ],
      consoleAtFailure: ['POST /api/orders 500'],
      domAtFailure: { bodyTextSample: 'Something went wrong', visibleButtons: ['Submit', 'Retry'], visibleInputs: [] },
    },
    error: { message: 'Expected navigation to /orders/confirmed' },
    explorationRoute: {
      url: '/orders',
      selectors: ["role=button[name='Submit']", 'input[name=address]'],
    },
    acceptanceCriterion: {
      id: 'F1.S2.AC1',
      text: 'User can submit an order and see confirmation.',
    },
    testSource: '// irrelevant — we never auto-patch app_is_wrong\n',
  };
}

function clusterBundles() {
  // Three tier-B-admin tests all hit /login because the auth context died.
  // Classifier should fire Rule 4 on each and cluster detector should mark
  // them tier-wide (since all bundles share the same tier).
  const mk = (name) => ({
    testName: `${name} [REQ:F3.S1.AC1]`,
    file: `tests/generated/${name}.spec.ts`,
    tier: 'tierB-auth-admin',
    trace: {
      failedAction: {
        name: 'page.goto',
        selector: null,
        url: 'https://example.com/login',
        errorText: 'Authentication required. Redirected to /login.',
      },
      networkAtFailure: [{ url: '/login', method: 'GET', status: 200, duration: 50 }],
      consoleAtFailure: [],
      domAtFailure: { bodyTextSample: 'Sign in', visibleButtons: ['Sign in'], visibleInputs: ['email'] },
    },
    error: { message: 'Authentication required. Redirected to /login 401 unauthorized.' },
    explorationRoute: null,
    acceptanceCriterion: null,
    testSource: '',
  });
  return [mk('admin-users'), mk('admin-settings'), mk('admin-audit')];
}

// ───────────────────────────────────────────────────────────────── Scenario A
test('T8-A hallucinated-selector fixture → classifier test_is_wrong → auto_apply', () => {
  const bundle = hallucinatedBundle();
  const verdict = classifyOne(bundle);
  assert.equal(verdict.verdict, 'test_is_wrong', 'classifier identifies hallucinated selector');
  assert.equal(verdict.reason, 'hallucinated_selector');
  assert.ok(verdict.confidence >= AUTO_APPLY_CONFIDENCE_FLOOR, 'confidence above auto-apply floor');

  const report = {
    stats: { total: 5, passed: 4, failed: 1, skipped: 0, flaky: 0 },
    failures: [bundle],
    classifierVerdicts: [verdict],
  };

  // AI echoes the classifier and proposes a safe patch that keeps [REQ:] intact.
  const aiAnalysis = [{
    testName: bundle.testName,
    verdict: 'test_is_wrong',
    verdictConfidence: 0.9,
    reason: 'Exploration shows the button is "Buy now", not "Place order".',
    suggestedPatch: {
      file: bundle.file,
      lineStart: 5,
      lineEnd: 5,
      oldCode: "page.getByRole('button', { name: 'Place order' })",
      newCode: "page.getByRole('button', { name: 'Buy now' })",
      preservesRequirementTag: true,
    },
  }];

  const resp = buildAgentResponse({
    report,
    projectPath: null,
    dashboardUrl: 'https://app.healix.dev',
    testRunId: 'run_abc',
    aiAnalysis,
  });

  assert.equal(resp.verdicts.auto_apply.length, 1, 'exactly one auto_apply entry');
  assert.equal(resp.verdicts.surface_for_approval.length, 0);
  assert.equal(resp.verdicts.app_regressions.length, 0);
  const entry = resp.verdicts.auto_apply[0];
  assert.equal(entry.testName, bundle.testName);
  assert.equal(entry.patch.newCode, "page.getByRole('button', { name: 'Buy now' })");
  assert.match(resp.actionPlan, /Auto-apply/);
  assert.match(resp.actionPlan, /Buy now/);
});

// ───────────────────────────────────────────────────────────────── Scenario B
test('T8-B real regression (500 on API) → classifier app_is_wrong → app_regressions, never auto-patched', () => {
  const bundle = realRegressionBundle();
  const verdict = classifyOne(bundle);
  assert.equal(verdict.verdict, 'app_is_wrong', 'classifier flags server error as app bug');
  assert.match(verdict.reason, /server_error_500/);

  const report = {
    stats: { total: 3, passed: 2, failed: 1, skipped: 0, flaky: 0 },
    failures: [bundle],
    classifierVerdicts: [verdict],
  };

  const resp = buildAgentResponse({
    report,
    dashboardUrl: 'https://app.healix.dev',
    testRunId: 'run_reg',
    aiAnalysis: [], // classifier conf 0.88 is enough; no AI needed
  });

  assert.equal(resp.verdicts.auto_apply.length, 0, 'app regressions NEVER auto-applied');
  assert.equal(resp.verdicts.app_regressions.length, 1);
  assert.equal(resp.verdicts.surface_for_approval.length, 0);
  const entry = resp.verdicts.app_regressions[0];
  assert.equal(entry.testName, bundle.testName);
  assert.equal(entry.affectedUrl, 'https://example.com/orders');
  assert.match(resp.actionPlan, /DO NOT auto-edit app source/);
});

// ───────────────────────────────────────────────────────────────── Scenario C
test('T8-C pipeline error → buildAgentResponse surfaces pipeline_error with stderr + remediation', () => {
  const report = {
    stats: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
    failures: [],
    classifierVerdicts: [],
    pipelineError: {
      stage: 'validation',
      reason: 'playwright_list_failed',
      stderr: "Error: Cannot find module '@playwright/test'\n    at Module._resolveFilename",
      generatedSpecCount: 4,
      userFacingMessage: 'Install @playwright/test in the target project, then re-run.',
    },
  };

  const resp = buildAgentResponse({
    report,
    dashboardUrl: 'https://app.healix.dev',
    testRunId: 'run_pipe',
  });

  assert.equal(resp.summary.pipelineError, true);
  assert.ok(resp.verdicts.pipeline_error, 'pipeline_error block present');
  assert.equal(resp.verdicts.pipeline_error.stage, 'validation');
  assert.equal(resp.verdicts.pipeline_error.reason, 'playwright_list_failed');
  assert.match(resp.verdicts.pipeline_error.stderrPreview, /Cannot find module/);
  assert.equal(resp.verdicts.pipeline_error.generatedSpecCount, 4);
  assert.match(resp.verdicts.pipeline_error.remediation, /Install @playwright\/test/);
  assert.equal(resp.verdicts.pipeline_error.dashboardUrl, 'https://app.healix.dev/test-run/run_pipe');
  assert.match(resp.actionPlan, /Pipeline error/);
});

// ───────────────────────────────────────────────────────────────── Scenario D
test('T8-D flake (fail → pass on retry) is counted distinctly and does NOT reach agent-response as a failure', () => {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-t8-flake-'));
  const resultsDir = path.join(reportsDir, 'healix-reports', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, 'results.json'),
    JSON.stringify({
      suites: [{
        title: 'generated',
        specs: [{
          title: 'animated banner loads [REQ:F2.S1.AC1]',
          file: 'tests/generated/banner.spec.ts',
          tests: [{
            projectName: 'tierA-public',
            status: 'flaky',
            results: [
              { status: 'failed', duration: 800, error: { message: 'animation-race' } },
              { status: 'passed', duration: 300 },
            ],
          }],
        }],
      }],
    }),
    'utf-8',
  );

  const pi = new PlaywrightIntegration({ projectPath: reportsDir });
  const parsed = pi.parseTestResults({ stdout: '', stderr: '', configPath: null, commandStartedAt: Date.now() });
  assert.equal(parsed.flaky, 1, 'flaky counter increments');
  assert.equal(parsed.failed, 0, 'not counted as failed');
  assert.equal(parsed.tests[0].retries, 1);

  const merger = new ResultsMerger();
  const tierResults = merger.computeTierResults(parsed.tests);
  assert.equal(tierResults['A-public'].flaky, 1, 'tier results carry flaky count');

  // buildAgentResponse sees no failures → no verdicts routed; summary flaky=1.
  const resp = buildAgentResponse({
    report: {
      stats: { total: 1, passed: 0, failed: 0, flaky: parsed.flaky, skipped: 0 },
      failures: [],
      classifierVerdicts: [],
    },
  });
  assert.equal(resp.summary.flaky, 1);
  assert.equal(resp.verdicts.auto_apply.length, 0);
  assert.equal(resp.verdicts.app_regressions.length, 0);
  assert.equal(resp.verdicts.environment_issues.length, 0);
});

// ───────────────────────────────────────────────────────────────── Scenario E
test('T8-E cluster: 3 tier-B-admin auth failures collapse into one cluster with tier-wide penalty', () => {
  const bundles = clusterBundles();
  const { verdicts, clusters } = classifyFailures(bundles);

  assert.equal(verdicts.length, 3);
  verdicts.forEach((v) => {
    assert.equal(v.verdict, 'environment', 'auth-failure rule fires on every bundle');
    assert.equal(v.reason, 'auth_context_missing');
    assert.ok(v.clusterId, 'clusterId populated');
  });
  assert.equal(clusters.length, 1, 'exactly one cluster');
  assert.equal(clusters[0].size, 3);
  assert.equal(clusters[0].tierWide, true, 'tier-wide marker fires when cluster covers whole tier');

  // Tier-wide penalty: confidences drop by 0.2 (from 0.80 → 0.60).
  verdicts.forEach((v) => {
    assert.ok(v.confidence <= 0.60 + 1e-9, `confidence penalized (${v.confidence})`);
  });

  const resp = buildAgentResponse({
    report: {
      stats: { total: 3, passed: 0, failed: 3, flaky: 0, skipped: 0 },
      failures: bundles,
      classifierVerdicts: verdicts,
      failureClusters: clusters,
    },
  });

  assert.equal(resp.verdicts.environment_issues.length, 3, 'each bundle surfaced as environment');
  assert.equal(resp.verdicts.auto_apply.length, 0);
  assert.equal(resp.verdicts.app_regressions.length, 0);
});

// ───────────────────────────────────────────────────────────────── Scenario F
test('T8-F user-override validator accepts the four legal verdicts and rejects everything else', () => {
  // The route file is a Next.js module that needs runtime wiring to load.
  // Instead of booting Next, we assert the validator's allow-list shape by
  // reading the source — this keeps the test hermetic and catches any future
  // change that widens the allow-list by accident.
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'webapp', 'src', 'app', 'api', 'test-runs', '[id]', 'failure-verdict', 'route.ts'),
    'utf-8',
  );

  // 1. The allow-list must contain exactly these four verdicts.
  const m = /ALLOWED_OVERRIDES\s*=\s*new Set\(\[([^\]]+)\]\)/m.exec(routeSrc);
  assert.ok(m, 'ALLOWED_OVERRIDES declared with new Set([...])');
  const entries = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean);
  assert.deepEqual(entries.sort(), ['app_is_wrong', 'environment', 'flake', 'test_is_wrong']);

  // 2. The route must join on userId to prevent cross-user override.
  assert.match(routeSrc, /testRuns\.userId,\s*user\.id/);
  assert.match(routeSrc, /testFailures\.userId,\s*user\.id/);

  // 3. Override is written with a timestamp.
  assert.match(routeSrc, /userOverride:\s*override/);
  assert.match(routeSrc, /userOverrideAt:\s*new Date\(\)/);

  // 4. Rate-limited.
  assert.match(routeSrc, /checkRateLimit/);
});
