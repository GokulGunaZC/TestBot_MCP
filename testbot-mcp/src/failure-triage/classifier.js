/**
 * Deterministic failure classifier — Phase T3.
 *
 * Consumes `FailureEvidence` bundles produced by evidence-bundler and emits a
 * `Verdict` per failure plus cluster rollups. First-match-wins; if no rule
 * fires we surface `ambiguous` (conf 0) so the two-hypothesis AI layer (T4)
 * can take over.
 *
 * Why deterministic-first: (a) the LLM has a documented "blame the test" bias,
 * so running rule-based detection first prevents confident-wrong verdicts for
 * clear cases, and (b) for tier-wide outages (e.g. auth seed broken), the
 * cluster detector collapses 10 individual failures into one banner instead
 * of 10 tokens-hungry AI calls.
 */
'use strict';

const VERDICTS = Object.freeze({
  TEST_WRONG: 'test_is_wrong',
  APP_WRONG: 'app_is_wrong',
  ENVIRONMENT: 'environment',
  AMBIGUOUS: 'ambiguous',
});

const RE_SELECTOR_NOT_FOUND = /(strict mode violation|resolved to 0 elements|waiting for (locator|selector)|locator\.[a-zA-Z]+: Timeout)/i;
const RE_SERVER_UNREACHABLE = /(net::ERR_|ECONNREFUSED|ENOTFOUND|socket hang up|timeout.*goto|page\.goto: Timeout)/i;
const RE_AUTH_FAILURE = /(login|sign.?in|authentication|unauthorized|401)/i;
const RE_ASSERTION_FAIL = /(expect\(.*?\)\.(to[A-Za-z]+)|Expected (string|substring|value)|toHaveText|toHaveURL|toContainText|toBeVisible|toHaveValue)/i;
const RE_REQ_TAG = /\[REQ:[A-Za-z0-9.]+\]/;

/**
 * Normalize a selector so we can compare "button[name='Buy']" against the
 * exploration artifact's selectors without being tripped up by whitespace or
 * quote-style differences.
 */
function normalizeSelector(sel) {
  if (typeof sel !== 'string') return '';
  return sel
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Did the exploration artifact route for the failing URL include this selector?
 * Returns `true` if any route selector loosely matches (substring either way).
 */
function explorationKnowsSelector(explorationRoute, selector) {
  if (!explorationRoute || !selector) return false;
  const needle = normalizeSelector(selector);
  if (!needle) return false;
  const selectors = Array.isArray(explorationRoute.selectors) ? explorationRoute.selectors : [];
  return selectors.some((s) => {
    const n = normalizeSelector(s);
    if (!n) return false;
    return n === needle || n.includes(needle) || needle.includes(n);
  });
}

/**
 * Try to pull a selector out of the failure evidence. Prefer the trace's
 * failedAction.selector; fall back to parsing it out of the error message.
 */
function inferFailingSelector(bundle) {
  const direct = bundle?.trace?.failedAction?.selector;
  if (direct) return direct;

  const msg = bundle?.error?.message || bundle?.trace?.failedAction?.errorText || '';
  const selLocator = /locator\(['"`]([^'"`)]+)['"`]\)/.exec(msg);
  if (selLocator) return selLocator[1];
  const selRole = /getByRole\(['"`]([^'"`)]+)['"`]\s*,\s*\{\s*name:\s*['"`]([^'"`}]+)['"`]/.exec(msg);
  if (selRole) return `role=${selRole[1]}[name="${selRole[2]}"]`;
  const selText = /getByText\(['"`]([^'"`)]+)['"`]\)/.exec(msg);
  if (selText) return `text=${selText[1]}`;
  return null;
}

function firstServerErrorRequest(networkAtFailure) {
  if (!Array.isArray(networkAtFailure)) return null;
  return networkAtFailure.find((r) => Number(r?.status) >= 500) || null;
}

/**
 * Classify a single failure bundle. Returns a Verdict:
 *
 *   {
 *     verdict:     'test_is_wrong' | 'app_is_wrong' | 'environment' | 'ambiguous',
 *     confidence:  0..1,
 *     reason:      short slug (e.g. 'hallucinated_selector'),
 *     ruleId:      which rule fired (1..6),
 *     selectorKey: normalized selector — used for cluster grouping,
 *   }
 */
function classifyOne(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return {
      verdict: VERDICTS.AMBIGUOUS, confidence: 0, reason: 'no_evidence', ruleId: 0, selectorKey: null,
    };
  }

  const errorText = String(
    bundle?.error?.message || bundle?.trace?.failedAction?.errorText || '',
  );
  const network = bundle?.trace?.networkAtFailure || [];

  // Rule 3 — environment comes first: if the dev server is down, every
  // selector-lookup will "fail", so we'd mis-fire Rule 1 if Rule 3 didn't
  // pre-empt it.
  if (RE_SERVER_UNREACHABLE.test(errorText)) {
    return {
      verdict: VERDICTS.ENVIRONMENT,
      confidence: 0.92,
      reason: 'server_unreachable',
      ruleId: 3,
      selectorKey: null,
    };
  }

  // Rule 2 — any 5xx in the network trail points squarely at the app.
  const serverErr = firstServerErrorRequest(network);
  if (serverErr) {
    const url = String(serverErr.url || '').slice(0, 120) || 'unknown';
    return {
      verdict: VERDICTS.APP_WRONG,
      confidence: 0.88,
      reason: `server_error_${serverErr.status}_${url}`,
      ruleId: 2,
      selectorKey: inferFailingSelector(bundle),
    };
  }

  // Rule 1 — selector-not-found. Hallucinated (unknown to exploration) vs.
  // genuinely removed (known to exploration but missing now).
  if (RE_SELECTOR_NOT_FOUND.test(errorText)) {
    const selector = inferFailingSelector(bundle);
    const known = explorationKnowsSelector(bundle.explorationRoute, selector);
    if (!known) {
      return {
        verdict: VERDICTS.TEST_WRONG,
        confidence: 0.90,
        reason: 'hallucinated_selector',
        ruleId: 1,
        selectorKey: selector,
      };
    }
    return {
      verdict: VERDICTS.APP_WRONG,
      confidence: 0.75,
      reason: 'selector_removed_since_exploration',
      ruleId: 1,
      selectorKey: selector,
    };
  }

  // Rule 4 — tier-B test hit login/auth in the failed action. Upstream should
  // have caught it as `blocked`; if we're here, the auth context is gone.
  const tier = String(bundle?.tier || '').toLowerCase();
  const isTierB = tier.startsWith('tierb');
  const failedActionUrl = bundle?.trace?.failedAction?.url || '';
  if (isTierB && (RE_AUTH_FAILURE.test(errorText) || /\/login|\/sign.?in/i.test(failedActionUrl))) {
    return {
      verdict: VERDICTS.ENVIRONMENT,
      confidence: 0.80,
      reason: 'auth_context_missing',
      ruleId: 4,
      selectorKey: null,
    };
  }

  // Rule 5 — assertion failure where the selector *did* resolve (so not a
  // selector bug). The app rendered content that doesn't match the AC.
  // The trace's failedAction.name is 'expect.*' when this path fires.
  const failedActionName = String(bundle?.trace?.failedAction?.name || '');
  const lookedLikeAssertion = RE_ASSERTION_FAIL.test(errorText) || /^expect/i.test(failedActionName);
  const selectorResolved = bundle?.trace?.failedAction?.selector && !RE_SELECTOR_NOT_FOUND.test(errorText);
  if (lookedLikeAssertion && selectorResolved) {
    return {
      verdict: VERDICTS.APP_WRONG,
      confidence: 0.70,
      reason: 'assertion_mismatch',
      ruleId: 5,
      selectorKey: inferFailingSelector(bundle),
    };
  }

  // Rule 6 — out of deterministic signal. Hand to AI.
  return {
    verdict: VERDICTS.AMBIGUOUS,
    confidence: 0,
    reason: 'no_rule_matched',
    ruleId: 6,
    selectorKey: inferFailingSelector(bundle),
  };
}

/**
 * Cluster detection — group by `{reason, selectorKey}` and promote any group
 * of size ≥ 3 into a cluster. If a cluster spans every failure in one tier,
 * we emit a synthetic tier-wide verdict AND penalize member confidences by
 * -0.2 so the dashboard surfaces it as a single banner instead of 10 chips.
 */
function clusterVerdicts(bundles, verdicts) {
  const groups = new Map();
  verdicts.forEach((v, idx) => {
    const key = `${v.reason}::${v.selectorKey || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  const clusters = [];
  let clusterCounter = 0;
  for (const [signature, idxs] of groups.entries()) {
    if (idxs.length < 3) continue;
    const clusterId = `cluster-${++clusterCounter}`;

    const memberTiers = new Set(idxs.map((i) => bundles[i]?.tier || null).filter(Boolean));
    const allBundleTiers = new Set(bundles.map((b) => b?.tier || null).filter(Boolean));
    const isTierWide = memberTiers.size === 1
      && allBundleTiers.size === 1
      && [...memberTiers][0] === [...allBundleTiers][0];

    idxs.forEach((i) => {
      verdicts[i].clusterId = clusterId;
      if (isTierWide) {
        verdicts[i].confidence = Math.max(0, Number((verdicts[i].confidence - 0.2).toFixed(2)));
      }
    });

    const [sampleReason] = signature.split('::');
    clusters.push({
      clusterId,
      signature,
      size: idxs.length,
      tierWide: isTierWide,
      memberIndexes: idxs,
      verdict: isTierWide ? VERDICTS.ENVIRONMENT : verdicts[idxs[0]].verdict,
      reason: isTierWide ? 'tier_wide_failure' : sampleReason,
      tier: [...memberTiers][0] || null,
    });
  }

  return clusters;
}

/**
 * Public entrypoint — runs classifyOne on every bundle, applies cluster
 * detection, returns `{ verdicts, clusters, aiEligibleIndexes }`.
 *
 * `aiEligibleIndexes` lists the failures that still need AI — deterministic
 * verdicts with confidence ≥ 0.80 don't. This is how pipeline-worker decides
 * which bundles to ship to /api/analyze-failures.
 */
function classifyFailures(bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  const verdicts = list.map(classifyOne);
  const clusters = clusterVerdicts(list, verdicts);

  const AI_SKIP_THRESHOLD = 0.80;
  const aiEligibleIndexes = verdicts
    .map((v, i) => ((v.confidence >= AI_SKIP_THRESHOLD) ? -1 : i))
    .filter((i) => i >= 0);

  return { verdicts, clusters, aiEligibleIndexes };
}

module.exports = {
  VERDICTS,
  classifyFailures,
  classifyOne,
  clusterVerdicts,
  normalizeSelector,
  explorationKnowsSelector,
  inferFailingSelector,
};
