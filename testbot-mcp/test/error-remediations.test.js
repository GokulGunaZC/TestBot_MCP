'use strict';

/**
 * Unit tests for the errorCode → remediation registry.
 *
 * These lock in the contract the Cursor agent depends on: every classified
 * pipeline errorCode must produce a remediation block with (a) an
 * agentInstruction string, (b) at least one actionable step, and (c) a `retry`
 * pointer telling the agent how to resume Healix after the fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REMEDIATIONS,
  getRemediationForErrorCode,
  buildRemediationBlock,
  formatRemediationBlock,
} = require('../src/failure-triage/error-remediations');

const CLASSIFIED_CODES = [
  'WEBAPP_UNREACHABLE',
  'PLAYWRIGHT_DEPENDENCY_MISSING',
  'MISSING_DEPENDENCY',
  'FIXTURE_MODULE_TYPE_MISMATCH',
  'SERVER_START_TIMEOUT',
  'NO_TESTS_LOADED',
  'GENERATED_TEST_SYNTAX_ERROR',
  'EXPO_DEPENDENCY_VALIDATION_FAILED',
  'TIME_BUDGET_EXCEEDED',
  'GENERATION_VALIDATION_FAILED',
  'PIPELINE_FAILED',
];

test('every classified errorCode from the stderr classifier has a remediation entry', () => {
  for (const code of CLASSIFIED_CODES) {
    assert.ok(REMEDIATIONS[code], `missing remediation for ${code}`);
  }
});

test('each remediation entry has the required agent-facing shape', () => {
  for (const [code, entry] of Object.entries(REMEDIATIONS)) {
    assert.equal(typeof entry.headline, 'string', `${code} missing headline`);
    assert.equal(typeof entry.agentInstruction, 'string', `${code} missing agentInstruction`);
    assert.equal(typeof entry.fixable, 'boolean', `${code} missing fixable flag`);
    assert.ok(Array.isArray(entry.remediationSteps) && entry.remediationSteps.length > 0,
      `${code} must have at least one remediation step`);
    assert.ok(entry.retry && typeof entry.retry.tool === 'string',
      `${code} must specify a retry.tool`);
  }
});

test('WEBAPP_UNREACHABLE is fixable and instructs agent to start the webapp', () => {
  const block = buildRemediationBlock({ errorCode: 'WEBAPP_UNREACHABLE' });
  assert.equal(block.fixable, true);
  assert.match(block.agentInstruction, /webapp/i);
  const shellSteps = block.remediationSteps.filter((s) => s.kind === 'shell');
  assert.ok(shellSteps.some((s) => /npm run dev/.test(s.command)),
    'must contain an npm run dev step');
  assert.ok(block.remediationSteps.some((s) => s.kind === 'wait_for_url'),
    'must wait for the webapp to become ready');
});

test('PLAYWRIGHT_DEPENDENCY_MISSING is fixable and includes install alternates', () => {
  const block = buildRemediationBlock({ errorCode: 'PLAYWRIGHT_DEPENDENCY_MISSING' });
  assert.equal(block.fixable, true);
  const installStep = block.remediationSteps.find((s) => /install/i.test(s.command || ''));
  assert.ok(installStep, 'must include an install step');
  assert.ok(installStep.alternates?.yarn && installStep.alternates?.pnpm,
    'install step must provide yarn + pnpm alternates');
});

test('SERVER_START_TIMEOUT is NOT fixable and asks the agent to surface to user', () => {
  const block = buildRemediationBlock({ errorCode: 'SERVER_START_TIMEOUT' });
  assert.equal(block.fixable, false);
  assert.ok(block.remediationSteps.some((s) => s.kind === 'surface_to_user'));
});

test('unknown errorCode falls back to a generic surface-to-user block (not an exception)', () => {
  const block = buildRemediationBlock({
    errorCode: 'TOTALLY_MADE_UP_CODE',
    fallbackMessage: 'Something weird happened.',
  });
  assert.equal(block.fixable, false);
  assert.equal(block.errorCode, 'TOTALLY_MADE_UP_CODE');
  assert.match(block.headline, /Something weird happened|unclassified/i);
  assert.ok(block.remediationSteps.some((s) => s.kind === 'surface_to_user'));
  // Still returns a retry pointer so the agent can reattempt after user input.
  assert.ok(block.retry && block.retry.tool);
});

test('getRemediationForErrorCode returns null for missing/invalid inputs', () => {
  assert.equal(getRemediationForErrorCode(null), null);
  assert.equal(getRemediationForErrorCode(''), null);
  assert.equal(getRemediationForErrorCode('NEVER_HEARD_OF_IT'), null);
});

test('formatRemediationBlock produces an agent-readable markdown string', () => {
  const block = buildRemediationBlock({ errorCode: 'WEBAPP_UNREACHABLE' });
  const md = formatRemediationBlock(block);
  assert.match(md, /## AGENT REMEDIATION/);
  assert.match(md, /errorCode: WEBAPP_UNREACHABLE/);
  assert.match(md, /fixable: yes/);
  assert.match(md, /Remediation steps/);
  assert.match(md, /npm run dev/);
  assert.match(md, /Wait for.*healthz/);
  assert.match(md, /After fixing:/);
});

test('formatRemediationBlock handles unknown-code fallback without crashing', () => {
  const block = buildRemediationBlock({ errorCode: 'MYSTERY', fallbackMessage: 'boom' });
  const md = formatRemediationBlock(block);
  assert.match(md, /errorCode: MYSTERY/);
  assert.match(md, /fixable: no/);
  assert.match(md, /Surface to user/);
});
