'use strict';

/**
 * Tests for the webapp triage prompt module. We compile the TS source to JS
 * once via typescript's transpileModule and then node:test the emitted module.
 *
 * Why this lives under testbot-mcp/test: the webapp doesn't have a runnable
 * test harness, and the prompt module is pure (no React / no Next runtime),
 * so the cheapest path to coverage is to load it from here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const TRIAGE_TS = path.resolve(
  __dirname,
  '..',
  '..',
  'webapp',
  'src',
  'lib',
  'triage',
  'prompt.ts',
);

let triageModule;
try {
  const ts = require(path.resolve(__dirname, '..', '..', 'node_modules', 'typescript'));
  const src = fs.readFileSync(TRIAGE_TS, 'utf-8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: false,
    },
  });
  const tmp = path.join(os.tmpdir(), `healix-triage-prompt-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, outputText, 'utf-8');
  // Load via Module to keep CommonJS exports intact.
  triageModule = require(tmp);
} catch (err) {
  // Skip if TS compile chain isn't wired up in this env.
  console.warn('[triage-prompt.test] Skipping — failed to transpile:', err?.message);
}

test('buildTestTriagePrompt references every evidence field a classifier missed', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { buildTestTriagePrompt } = triageModule;

  const bundle = {
    kind: 'test',
    testName: '[REQ:F1.S1.AC1] user can log in',
    file: 'tests/generated/login.spec.ts',
    tier: 'tierb-auth-admin',
    role: 'admin',
    status: 'failed',
    duration: 1200,
    error: { message: "strict mode violation: getByRole('button', { name: 'Buy now' }) resolved to 0 elements" },
    testSource: `test('[REQ:F1.S1.AC1] user can log in', async ({ page }) => {\n  await page.getByRole('button', { name: 'Buy now' }).click();\n  await expect(page).toHaveURL('/dashboard');\n});`,
    acceptanceCriterion: {
      tag: 'F1.S1.AC1',
      text: 'User can sign in with valid credentials and land on /dashboard',
      authRequired: false,
    },
    explorationRoute: {
      path: '/login',
      selectors: ['button[type=submit]', 'input[name=email]'],
    },
    trace: {
      failedAction: { name: 'click', selector: 'role=button[name="Buy now"]', url: '/login', errorText: 'resolved to 0 elements' },
      domAtFailure: { bodyTextSample: 'Sign in to continue', visibleButtons: ['Sign in'], visibleInputs: ['email'] },
      networkAtFailure: [{ url: '/api/session', method: 'GET', status: 200, duration: 45 }],
      consoleAtFailure: ['warning: deprecated'],
      parseError: null,
    },
    classifierVerdict: { verdict: 'ambiguous', confidence: 0, reason: 'no_rule_matched', ruleId: 6 },
  };

  const prompt = buildTestTriagePrompt(bundle);
  assert.ok(prompt.includes('[REQ:F1.S1.AC1]'), 'preserves REQ tag in title');
  assert.ok(prompt.includes('tierb-auth-admin'), 'includes tier');
  assert.ok(prompt.includes('button[type=submit]'), 'lists exploration selectors');
  assert.ok(prompt.includes('role=button[name="Buy now"]'), 'includes failed selector');
  assert.ok(prompt.includes('User can sign in with valid credentials'), 'includes AC text');
  assert.ok(prompt.includes('classifierVerdict'), 'shows classifier pre-verdict');
  assert.ok(prompt.includes('ambiguous'), 'classifier reason propagated');
  assert.ok(prompt.includes('prove the selector is not in explorationRoute.selectors'), 'anti-bias reminder present');
});

test('isEvidenceBundle distinguishes new-shape bundles from legacy failure objects', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { isEvidenceBundle } = triageModule;

  assert.equal(isEvidenceBundle({ kind: 'test', trace: {} }), true);
  assert.equal(isEvidenceBundle({ kind: 'test', acceptanceCriterion: { tag: 'X' } }), true);
  assert.equal(isEvidenceBundle({ kind: 'test', explorationRoute: { selectors: [] } }), true);
  assert.equal(isEvidenceBundle({ kind: 'test', classifierVerdict: { verdict: 'ambiguous' } }), true);

  // Legacy shape — no structured evidence fields
  assert.equal(isEvidenceBundle({ testName: 'x', error: { message: 'y' } }), false);
  assert.equal(isEvidenceBundle({ kind: 'pipeline', stderr: 'x' }), false);
  assert.equal(isEvidenceBundle(null), false);
  assert.equal(isEvidenceBundle('string'), false);
});

test('validatePatchGuardrail blocks patches that remove the REQ tag', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { validatePatchGuardrail } = triageModule;

  const testSource = `test('[REQ:F1.S1.AC1] user can log in', async ({ page }) => {
  await page.getByRole('button', { name: 'Buy now' }).click();
  await expect(page).toHaveURL('/dashboard');
});`;

  // Good: selector swap that keeps REQ tag + expect
  const ok = validatePatchGuardrail({
    file: 'tests/generated/login.spec.ts',
    lineStart: 2,
    lineEnd: 2,
    oldCode: `await page.getByRole('button', { name: 'Buy now' }).click();`,
    newCode: `await page.getByRole('button', { name: 'Sign in' }).click();`,
    preservesRequirementTag: true,
  }, testSource);
  assert.equal(ok.ok, true);

  // Bad: patch tries to rewrite the test title and drops the [REQ:] tag
  const badTag = validatePatchGuardrail({
    file: 'tests/generated/login.spec.ts',
    lineStart: 1,
    lineEnd: 1,
    oldCode: `test('[REQ:F1.S1.AC1] user can log in', async ({ page }) => {`,
    newCode: `test('user can log in', async ({ page }) => {`,
    preservesRequirementTag: false,
  }, testSource);
  assert.equal(badTag.ok, false);
  assert.equal(badTag.reason, 'patch_removes_req_tag');
});

test('validatePatchGuardrail blocks patches whose oldCode is not in source', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { validatePatchGuardrail } = triageModule;

  const testSource = `test('[REQ:F1.S1.AC1] x', () => { expect(1).toBe(1); });`;
  const hallucinated = validatePatchGuardrail({
    file: 'x.spec.ts',
    lineStart: 1,
    lineEnd: 1,
    oldCode: 'something that never appears in the source',
    newCode: 'expect(2).toBe(2)',
    preservesRequirementTag: true,
  }, testSource);
  assert.equal(hallucinated.ok, false);
  assert.equal(hallucinated.reason, 'patch_oldCode_not_in_source');
});

test('validatePatchGuardrail returns no_patch when patch is null', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { validatePatchGuardrail } = triageModule;
  const r = validatePatchGuardrail(null, `test('[REQ:F1.S1.AC1] x', () => {});`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_patch');
});

test('TEST_TRIAGE_SYSTEM_PROMPT carries the anti-bias and patch guardrail clauses', (t) => {
  if (!triageModule) return t.skip('typescript transpilation unavailable');
  const { TEST_TRIAGE_SYSTEM_PROMPT } = triageModule;
  assert.ok(TEST_TRIAGE_SYSTEM_PROMPT.includes('first instinct should NOT be to fix the test'),
    'anti-bias clause present');
  assert.ok(TEST_TRIAGE_SYSTEM_PROMPT.includes('[REQ:'), 'REQ guardrail present');
  assert.ok(TEST_TRIAGE_SYSTEM_PROMPT.includes('expect('), 'expect() guardrail present');
  assert.ok(TEST_TRIAGE_SYSTEM_PROMPT.includes('alternativeHypothesis'), 'alternative hypothesis field required');
  assert.ok(TEST_TRIAGE_SYSTEM_PROMPT.includes('evidenceUsed'), 'evidenceUsed field required');
});
