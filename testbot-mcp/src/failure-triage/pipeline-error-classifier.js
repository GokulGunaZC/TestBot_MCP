'use strict';

/**
 * Pipeline-error stderr/stdout classifier.
 *
 * When the Healix pipeline fails BEFORE any test reports a result (validation
 * broke, Playwright's loader crashed, dev server never became ready, etc.),
 * we must not let the failure be rendered as `stage: unknown, reason:
 * unknown_reason` — the dashboard banner is useless to the Cursor agent and
 * the user when that happens.
 *
 * This classifier inspects the pipeline's stderr/stdout (and an optional hint
 * about which stage threw) and returns a deterministic `{stage, reason,
 * errorCode, userFacingMessage}` block. Adding new patterns only needs a new
 * entry in CLASSIFIERS below plus a node:test case.
 *
 * Rules are evaluated in declaration order; first match wins. Each rule is a
 * tight regex against the raw stderr/stdout. Be specific — over-broad patterns
 * will mask finer-grained rules and downgrade signal.
 *
 * The real-world failure this module was born to cover (pm-app, 2026-04-18):
 *   "Playwright execution failed with exit code 1: SyntaxError: The requested
 *    module './__healix-fixture' does not provide an export named 'expect'
 *    | SyntaxError: The requested module './__healix-fixture' does not
 *    provide an export named 'expect' | Error: No tests found"
 * → `stage: 'execution', reason: 'fixture_module_type_mismatch'` instead of
 *   `stage: 'unknown', reason: null`.
 */

const CLASSIFIERS = [
  {
    id: 'fixture_module_type_mismatch',
    // The smoking gun for the pm-app regression: Node parsed the generated
    // __healix-fixture.js as ESM but the body used module.exports (CJS).
    test: (s) => /does not provide an export named ['"](test|expect|request)['"]/i.test(s)
      || /The requested module '.*healix-fixture.*' does not provide/i.test(s),
    stage: 'execution',
    errorCode: 'FIXTURE_MODULE_TYPE_MISMATCH',
    userFacingMessage: 'The generated Playwright fixture was parsed as ESM but the file body used CommonJS exports. Healix now matches the fixture body to your project\'s package.json `"type"`; re-run to pick up the fix.',
  },
  {
    id: 'generated_test_syntax_error',
    test: (s) => /SyntaxError:/i.test(s) && !/does not provide an export/i.test(s),
    stage: 'execution',
    errorCode: 'GENERATED_TEST_SYNTAX_ERROR',
    userFacingMessage: 'A generated test file failed to parse. Open the failing spec from the dashboard banner, fix the offending line (or delete the file and rerun), and try again.',
  },
  {
    id: 'no_tests_loaded',
    test: (s) => /Error:\s*No tests found/i.test(s),
    stage: 'execution',
    errorCode: 'NO_TESTS_LOADED',
    userFacingMessage: 'Playwright loaded zero tests — usually because a test file failed to import. Check the stderr above this line for the import/syntax error that blocked the loader.',
  },
  {
    id: 'missing_playwright_dependency',
    test: (s) => /Cannot find module ['"]@playwright\/test['"]/i.test(s)
      || /package subpath ['"]\.?\/cli\.js['"] is not defined by ["']exports["']/i.test(s),
    stage: 'validation',
    errorCode: 'PLAYWRIGHT_DEPENDENCY_MISSING',
    userFacingMessage: '@playwright/test is not resolvable from the target project. Run `npm install @playwright/test --save-dev` (or yarn/pnpm equivalent) in the project root, then re-run Healix.',
  },
  {
    id: 'missing_node_module',
    test: (s) => /Cannot find module ['"][^@]/i.test(s) && !/@playwright\/test/.test(s),
    stage: 'validation',
    errorCode: 'MISSING_DEPENDENCY',
    userFacingMessage: 'A module required by a generated test cannot be resolved. Install the missing dependency or adjust the generator config that produced the stale import.',
  },
  {
    id: 'webapp_unreachable',
    // MCP worker couldn't reach the Healix webapp itself (not the target
    // project's dev server). Matches both the explicit WEBAPP_UNREACHABLE
    // code and the underlying "fetch failed" from Node's fetch/undici.
    test: (s) => /WEBAPP_UNREACHABLE|Cannot reach Healix webapp|Cannot reach Healix webapp at https?:\/\//i.test(s)
      || (/fetch failed/i.test(s) && /\/api\/(generate-tests|parse-prd|analyze-failures|exploration\/plan)/i.test(s)),
    stage: 'execution',
    errorCode: 'WEBAPP_UNREACHABLE',
    userFacingMessage: 'Healix could not reach the webapp at the configured HEALIX_DASHBOARD_URL. Start the webapp (`cd webapp && npm run dev` → http://localhost:3000), or point HEALIX_DASHBOARD_URL at your deployed instance, then re-run.',
  },
  {
    id: 'server_unreachable',
    test: (s) => /(ECONNREFUSED|net::ERR_CONNECTION_REFUSED|ENOTFOUND)/i.test(s),
    stage: 'server_start',
    errorCode: 'SERVER_START_TIMEOUT',
    userFacingMessage: 'Healix could not reach the dev server. Verify the start command, base URL, and port in the config form, then re-run.',
  },
  {
    id: 'playwright_list_failed',
    test: (s) => /playwright\s+test\s+--list/i.test(s) && /error/i.test(s),
    stage: 'validation',
    errorCode: 'GENERATION_VALIDATION_FAILED',
    userFacingMessage: 'Generated tests did not pass Playwright\'s pre-run validation. Open the banner\'s stderr for the exact line, fix the generated spec, and re-run.',
  },
  {
    id: 'expo_dependency_validation',
    test: (s) => /expo.*dependency.*validation/i.test(s),
    stage: 'server_start',
    errorCode: 'EXPO_DEPENDENCY_VALIDATION_FAILED',
    userFacingMessage: 'Expo blocked startup with a dependency-version check. Run `npx expo install --check` or pin compatible versions.',
  },
  {
    id: 'time_budget_exceeded',
    test: (s) => /time budget exceeded|HEALIX_TIMEOUT|TIME_BUDGET_EXCEEDED/i.test(s),
    stage: 'execution',
    errorCode: 'TIME_BUDGET_EXCEEDED',
    userFacingMessage: 'Healix hit the configured time budget before tests finished. Raise the budget in the config form or reduce coverage profile.',
  },
];

/**
 * Inspect stderr/stdout and return a structured classification. When nothing
 * matches, we fall back to a best-effort `{stage, reason}` — but we NEVER
 * return `stage: "unknown"` or `reason: "unknown_reason"`. If the caller has
 * a more specific hint via `hintedStage`, we prefer it.
 *
 * @returns {{id, stage, errorCode, reason, userFacingMessage}} classification
 */
function classifyPipelineErrorFromStderr({ stderr = '', stdout = '', hintedStage = null } = {}) {
  const haystack = [stderr || '', stdout || ''].join('\n');
  for (const rule of CLASSIFIERS) {
    if (rule.test(haystack)) {
      return {
        id: rule.id,
        stage: hintedStage || rule.stage,
        errorCode: rule.errorCode,
        reason: rule.id,
        userFacingMessage: rule.userFacingMessage,
      };
    }
  }
  return {
    id: 'unclassified_pipeline_error',
    stage: hintedStage || 'execution',
    errorCode: 'PIPELINE_FAILED',
    reason: 'unclassified_pipeline_error',
    userFacingMessage: 'Pipeline exited before tests completed. Open the dashboard banner — Healix attached full stderr and the first generated spec so you can diagnose.',
  };
}

/**
 * Merge an existing (partial) diagnostics block with a classifier result so
 * callers can enrich without losing fields they already set. Explicit fields
 * on `partial` win; classifier fills in the gaps.
 */
function mergeWithClassification(partial, classification) {
  const p = partial || {};
  return {
    ...p,
    stage: p.stage && p.stage !== 'unknown' ? p.stage : classification.stage,
    reason: p.reason && p.reason !== 'unknown_reason' ? p.reason : classification.reason,
    errorCode: p.errorCode || classification.errorCode,
    userFacingMessage: p.userFacingMessage || classification.userFacingMessage,
  };
}

module.exports = {
  classifyPipelineErrorFromStderr,
  mergeWithClassification,
  CLASSIFIERS,
};
