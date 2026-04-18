'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VERDICTS,
  classifyFailures,
  classifyOne,
  normalizeSelector,
  explorationKnowsSelector,
  inferFailingSelector,
} = require('../src/failure-triage/classifier');

function bundle(overrides = {}) {
  return {
    kind: 'test',
    testName: '[REQ:F1.S1.AC1] demo',
    file: 'tests/generated/demo.spec.ts',
    tier: 'tiera-public',
    role: null,
    status: 'failed',
    error: { message: '', stack: '' },
    trace: { failedAction: null, networkAtFailure: [], consoleAtFailure: [], domAtFailure: null, parseError: null },
    explorationRoute: null,
    acceptanceCriterion: null,
    testSource: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('normalizeSelector strips quotes/case/whitespace', () => {
  assert.equal(normalizeSelector('Button[name="Sign In"]'), 'button[name=sign in]');
  assert.equal(normalizeSelector(null), '');
  assert.equal(normalizeSelector('  getByRole("button")  '), 'getbyrole(button)');
});

test('explorationKnowsSelector matches substrings either way', () => {
  const route = { selectors: ['button[type=submit]', 'input[name=email]'] };
  assert.equal(explorationKnowsSelector(route, 'button[type=submit]'), true);
  assert.equal(explorationKnowsSelector(route, 'BUTTON[type=SUBMIT]'), true);
  assert.equal(explorationKnowsSelector(route, 'button'), true, 'substring match works');
  assert.equal(explorationKnowsSelector(route, 'div[data-missing]'), false);
  assert.equal(explorationKnowsSelector(null, 'button'), false);
  assert.equal(explorationKnowsSelector(route, null), false);
});

test('inferFailingSelector extracts selector from Playwright error text', () => {
  assert.equal(
    inferFailingSelector(bundle({ error: { message: "locator('button[type=submit]') not visible" } })),
    'button[type=submit]',
  );
  const roleBundle = bundle({ error: { message: `getByRole('button', { name: 'Buy now' }) resolved to 0 elements` } });
  assert.equal(inferFailingSelector(roleBundle), 'role=button[name="Buy now"]');
  const textBundle = bundle({ error: { message: `getByText('Welcome back') not found` } });
  assert.equal(inferFailingSelector(textBundle), 'text=Welcome back');
  const directBundle = bundle({ trace: { failedAction: { selector: 'div#app' } } });
  assert.equal(inferFailingSelector(directBundle), 'div#app');
});

// ---------------------------------------------------------------------------
// Rule 1 — selector-not-found, hallucinated vs. removed
// ---------------------------------------------------------------------------

test('Rule 1: hallucinated selector → test_is_wrong (conf 0.90)', () => {
  const b = bundle({
    error: { message: `Error: strict mode violation: getByRole('button', { name: 'Buy now' }) resolved to 0 elements` },
    trace: { failedAction: { name: 'click', selector: 'role=button[name="Buy now"]', url: '/products', errorText: 'resolved to 0 elements' } },
    explorationRoute: { path: '/products', selectors: ['button[type=submit]', 'input[name=quantity]'] },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.TEST_WRONG);
  assert.equal(v.confidence, 0.90);
  assert.equal(v.reason, 'hallucinated_selector');
  assert.equal(v.ruleId, 1);
});

test('Rule 1: known selector but gone now → app_is_wrong (conf 0.75)', () => {
  const b = bundle({
    error: { message: `waiting for locator('button[type=submit]') to be visible` },
    trace: { failedAction: { name: 'click', selector: 'button[type=submit]', url: '/login', errorText: '' } },
    explorationRoute: { path: '/login', selectors: ['button[type=submit]', 'input[name=email]'] },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.APP_WRONG);
  assert.equal(v.confidence, 0.75);
  assert.equal(v.reason, 'selector_removed_since_exploration');
});

// ---------------------------------------------------------------------------
// Rule 2 — server error (5xx in network trail)
// ---------------------------------------------------------------------------

test('Rule 2: 5xx in network trail → app_is_wrong (conf 0.88)', () => {
  const b = bundle({
    error: { message: 'expected to reach /dashboard' },
    trace: {
      failedAction: { name: 'goto', selector: null, url: '/dashboard', errorText: '' },
      networkAtFailure: [
        { url: '/api/ping', method: 'GET', status: 200, duration: 10 },
        { url: '/api/orders', method: 'POST', status: 500, duration: 300 },
      ],
    },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.APP_WRONG);
  assert.equal(v.confidence, 0.88);
  assert.ok(v.reason.startsWith('server_error_500_'));
  assert.ok(v.reason.includes('/api/orders'));
});

// ---------------------------------------------------------------------------
// Rule 3 — server unreachable
// ---------------------------------------------------------------------------

test('Rule 3: ECONNREFUSED → environment (conf 0.92)', () => {
  const b = bundle({
    error: { message: 'page.goto: Timeout 30000ms exceeded — net::ERR_CONNECTION_REFUSED' },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.ENVIRONMENT);
  assert.equal(v.confidence, 0.92);
  assert.equal(v.reason, 'server_unreachable');
});

test('Rule 3 runs before Rule 1 (server down looks like selector-not-found)', () => {
  const b = bundle({
    // If server is down, Playwright often ALSO says "resolved to 0 elements"
    // for subsequent selector lookups — we must not mislabel this as test bug.
    error: { message: 'ECONNREFUSED 127.0.0.1:3000 -- resolved to 0 elements' },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.ENVIRONMENT);
  assert.equal(v.ruleId, 3);
});

// ---------------------------------------------------------------------------
// Rule 4 — tier-B auth context missing
// ---------------------------------------------------------------------------

test('Rule 4: tier-B test redirected to /login → environment (auth_context_missing)', () => {
  const b = bundle({
    tier: 'tierb-auth-admin',
    role: 'admin',
    error: { message: 'expected admin heading; got login page' },
    trace: { failedAction: { name: 'goto', selector: null, url: '/login?next=/admin', errorText: '' } },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.ENVIRONMENT);
  assert.equal(v.reason, 'auth_context_missing');
  assert.equal(v.ruleId, 4);
});

test('Rule 4 does NOT fire on tier-A even with auth wording (wrong tier)', () => {
  const b = bundle({
    tier: 'tiera-public',
    error: { message: 'login form did not appear' },
    trace: { failedAction: { name: 'click', selector: null, url: '/login', errorText: '' } },
  });
  const v = classifyOne(b);
  // Rule 4 skipped because tier is tierA; falls through to Rule 6.
  assert.equal(v.verdict, VERDICTS.AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// Rule 5 — assertion mismatch
// ---------------------------------------------------------------------------

test('Rule 5: expect().toHaveText mismatch with resolved selector → app_is_wrong', () => {
  const b = bundle({
    error: { message: `Expected substring: "Welcome, Alice"\nReceived string: "Welcome, Bob"` },
    trace: { failedAction: { name: 'expect.toHaveText', selector: '[data-testid=welcome]', url: '/dashboard', errorText: 'assertion failed' } },
  });
  const v = classifyOne(b);
  assert.equal(v.verdict, VERDICTS.APP_WRONG);
  assert.equal(v.confidence, 0.70);
  assert.equal(v.reason, 'assertion_mismatch');
  assert.equal(v.ruleId, 5);
});

// ---------------------------------------------------------------------------
// Rule 6 — fallthrough
// ---------------------------------------------------------------------------

test('Rule 6: nothing matched → ambiguous (conf 0)', () => {
  const v = classifyOne(bundle({ error: { message: 'something unrecognizable happened' } }));
  assert.equal(v.verdict, VERDICTS.AMBIGUOUS);
  assert.equal(v.confidence, 0);
  assert.equal(v.ruleId, 6);
});

test('classifyOne handles empty/null bundle gracefully', () => {
  const v = classifyOne(null);
  assert.equal(v.verdict, VERDICTS.AMBIGUOUS);
  assert.equal(v.reason, 'no_evidence');
});

// ---------------------------------------------------------------------------
// Cluster detection
// ---------------------------------------------------------------------------

test('classifyFailures groups ≥3 matching failures into one cluster', () => {
  const bundles = [
    bundle({
      error: { message: `strict mode violation: resolved to 0 elements` },
      trace: { failedAction: { selector: 'button.missing', url: '/a', errorText: '' } },
      explorationRoute: { path: '/a', selectors: [] },
    }),
    bundle({
      error: { message: `resolved to 0 elements` },
      trace: { failedAction: { selector: 'button.missing', url: '/b', errorText: '' } },
      explorationRoute: { path: '/b', selectors: [] },
    }),
    bundle({
      error: { message: `resolved to 0 elements` },
      trace: { failedAction: { selector: 'button.missing', url: '/c', errorText: '' } },
      explorationRoute: { path: '/c', selectors: [] },
    }),
  ];
  const { verdicts, clusters } = classifyFailures(bundles);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 3);
  assert.ok(verdicts.every((v) => v.clusterId === clusters[0].clusterId));
});

test('classifyFailures flags tier-wide cluster and penalizes member confidence', () => {
  // All 4 failures are tier-B-admin + identical signature → tier-wide.
  const mk = () => bundle({
    tier: 'tierb-auth-admin',
    role: 'admin',
    error: { message: 'login failed — 401 unauthorized' },
    trace: { failedAction: { name: 'goto', selector: null, url: '/login', errorText: '' } },
  });
  const bundles = [mk(), mk(), mk(), mk()];
  const { verdicts, clusters } = classifyFailures(bundles);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].tierWide, true);
  assert.equal(clusters[0].verdict, VERDICTS.ENVIRONMENT);
  // Rule 4 baseline conf=0.80, tier-wide penalty -0.2 → 0.60.
  for (const v of verdicts) {
    assert.equal(v.confidence, 0.60);
  }
});

test('classifyFailures ignores small groups (<3) for clustering', () => {
  const bundles = [
    bundle({ error: { message: 'resolved to 0 elements' }, trace: { failedAction: { selector: 'x', url: '/a' } } }),
    bundle({ error: { message: 'resolved to 0 elements' }, trace: { failedAction: { selector: 'x', url: '/a' } } }),
  ];
  const { clusters } = classifyFailures(bundles);
  assert.equal(clusters.length, 0);
});

test('classifyFailures.aiEligibleIndexes skips confident deterministic verdicts', () => {
  const bundles = [
    // high-conf test_is_wrong (0.90) → skip AI
    bundle({
      error: { message: 'strict mode violation: resolved to 0 elements' },
      trace: { failedAction: { selector: 'x.fake', url: '/a' } },
      explorationRoute: { path: '/a', selectors: [] },
    }),
    // ambiguous → AI eligible
    bundle({ error: { message: 'weird failure' } }),
    // environment 0.92 → skip AI
    bundle({ error: { message: 'net::ERR_CONNECTION_REFUSED' } }),
  ];
  const { aiEligibleIndexes } = classifyFailures(bundles);
  assert.deepEqual(aiEligibleIndexes, [1]);
});

test('classifyFailures returns empty structure for empty input', () => {
  const { verdicts, clusters, aiEligibleIndexes } = classifyFailures([]);
  assert.deepEqual(verdicts, []);
  assert.deepEqual(clusters, []);
  assert.deepEqual(aiEligibleIndexes, []);
});
