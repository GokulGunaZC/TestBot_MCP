'use strict';

/**
 * Unit tests for the pipeline-error stderr-pattern classifier.
 *
 * These regressions pin down every known failure signature the user has hit
 * in the field so future runs never display `stage: unknown, reason:
 * unknown_reason` on the dashboard again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPipelineErrorFromStderr,
  mergeWithClassification,
  CLASSIFIERS,
} = require('../src/failure-triage/pipeline-error-classifier');

test('pm-app real-world stderr → fixture_module_type_mismatch at execution', () => {
  // Verbatim from the 2026-04-18 dashboard screenshot that prompted this fix.
  const stderr = "Playwright execution failed with exit code 1: SyntaxError: "
    + "The requested module './__healix-fixture' does not provide an export "
    + "named 'expect' | SyntaxError: The requested module './__healix-fixture' "
    + "does not provide an export named 'expect' | Error: No tests found";
  const c = classifyPipelineErrorFromStderr({ stderr });
  assert.equal(c.id, 'fixture_module_type_mismatch');
  assert.equal(c.stage, 'execution');
  assert.equal(c.errorCode, 'FIXTURE_MODULE_TYPE_MISMATCH');
  assert.match(c.userFacingMessage, /parsed as ESM/);
  assert.notEqual(c.reason, 'unknown_reason');
  assert.notEqual(c.stage, 'unknown');
});

test('generic SyntaxError in generated test → generated_test_syntax_error', () => {
  const stderr = "at /abs/tests/generated/foo.spec.ts:12:3 SyntaxError: Unexpected token )";
  const c = classifyPipelineErrorFromStderr({ stderr });
  assert.equal(c.id, 'generated_test_syntax_error');
  assert.equal(c.stage, 'execution');
});

test('"No tests found" with no other hint → no_tests_loaded', () => {
  const c = classifyPipelineErrorFromStderr({ stderr: 'Error: No tests found' });
  assert.equal(c.id, 'no_tests_loaded');
  assert.equal(c.stage, 'execution');
});

test('missing @playwright/test module → validation + PLAYWRIGHT_DEPENDENCY_MISSING', () => {
  const c = classifyPipelineErrorFromStderr({ stderr: "Cannot find module '@playwright/test' from /abs/node_modules" });
  assert.equal(c.id, 'missing_playwright_dependency');
  assert.equal(c.stage, 'validation');
  assert.equal(c.errorCode, 'PLAYWRIGHT_DEPENDENCY_MISSING');
});

test('ECONNREFUSED → server_start', () => {
  const c = classifyPipelineErrorFromStderr({ stderr: 'Error: connect ECONNREFUSED 127.0.0.1:3000' });
  assert.equal(c.id, 'server_unreachable');
  assert.equal(c.stage, 'server_start');
});

test('expo dependency validation signals get their own bucket', () => {
  const c = classifyPipelineErrorFromStderr({ stderr: 'Expo dependency validation failed for react-native@...' });
  assert.equal(c.id, 'expo_dependency_validation');
  assert.equal(c.stage, 'server_start');
});

test('completely unrecognized stderr falls back without using "unknown"', () => {
  const c = classifyPipelineErrorFromStderr({ stderr: 'utterly-novel-boom' });
  assert.equal(c.id, 'unclassified_pipeline_error');
  assert.notEqual(c.stage, 'unknown');
  assert.notEqual(c.reason, 'unknown_reason');
  // Still produces a usable message so the banner is not empty.
  assert.ok(c.userFacingMessage.length > 10);
});

test('hintedStage wins when provided', () => {
  const c = classifyPipelineErrorFromStderr({
    stderr: 'Error: connect ECONNREFUSED',
    hintedStage: 'generation',
  });
  assert.equal(c.stage, 'generation');
  // Rule still matched — errorCode reflects the pattern.
  assert.equal(c.errorCode, 'SERVER_START_TIMEOUT');
});

test('mergeWithClassification preserves explicit caller fields', () => {
  const partial = { stage: 'validation', reason: 'playwright_list_failed' };
  const classification = classifyPipelineErrorFromStderr({ stderr: 'Cannot find module "@playwright/test"' });
  const merged = mergeWithClassification(partial, classification);
  assert.equal(merged.stage, 'validation', 'caller stage kept');
  assert.equal(merged.reason, 'playwright_list_failed', 'caller reason kept');
  assert.equal(merged.errorCode, 'PLAYWRIGHT_DEPENDENCY_MISSING', 'errorCode filled in');
});

test('mergeWithClassification replaces placeholder "unknown" stage/reason', () => {
  const merged = mergeWithClassification(
    { stage: 'unknown', reason: 'unknown_reason' },
    classifyPipelineErrorFromStderr({ stderr: 'SyntaxError: Unexpected token' }),
  );
  assert.notEqual(merged.stage, 'unknown');
  assert.notEqual(merged.reason, 'unknown_reason');
});

test('CLASSIFIERS order: fixture_module_type_mismatch wins over generic SyntaxError', () => {
  // Both patterns would match; the fixture-specific one must fire first so
  // the dashboard points at the root cause, not a generic syntax error.
  const fixture = CLASSIFIERS.findIndex((r) => r.id === 'fixture_module_type_mismatch');
  const generic = CLASSIFIERS.findIndex((r) => r.id === 'generated_test_syntax_error');
  assert.ok(fixture < generic, 'fixture_module_type_mismatch must be declared before generated_test_syntax_error');
});
