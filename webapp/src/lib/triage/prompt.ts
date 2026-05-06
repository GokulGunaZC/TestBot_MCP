/**
 * Two-hypothesis triage prompt — Phase T4.
 *
 * This is the prompt surface the AI uses for test-level failures that the
 * deterministic classifier could not resolve. The key design goals:
 *
 *   1. Force the model to consider BOTH "test is wrong" and "app is wrong"
 *      before committing, cutting its documented bias toward blaming tests.
 *   2. Require evidence-grounded reasoning (cite the field from the bundle).
 *   3. Make any proposed patch auto-apply-safe by preserving the `[REQ:...]`
 *      tag AND at least one `expect(...)` call — MCP re-verifies both flags.
 *
 * The prompt is parametrised by a single `FailureEvidenceBundle` (see the
 * evidence-bundler in testbot-mcp). Shape mirrors the structured evidence
 * emitted by `bundleOne` so webapp and MCP don't drift.
 */

export type Verdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'ambiguous'
export type FixTarget = 'test' | 'app' | 'env' | 'none'

export interface SuggestedPatch {
  file: string
  lineStart: number
  lineEnd: number
  oldCode: string
  newCode: string
  preservesRequirementTag: boolean
}

export interface TriageResult {
  verdict: Verdict
  verdictConfidence: number
  fixTarget: FixTarget
  reason: string
  suggestedPatch: SuggestedPatch | null
  alternativeHypothesis: string
  evidenceUsed: string[]
  rootCause?: string
  analysis?: string
  testingRecommendations?: string
}

export interface EvidenceBundle {
  kind: 'test'
  testName?: string
  file?: string | null
  tier?: string | null
  role?: string | null
  status?: string
  duration?: number
  error?: { message?: string; stack?: string }
  testSource?: string | null
  acceptanceCriterion?: {
    tag?: string
    text?: string | null
    authRequired?: boolean
    kind?: string | null
    unmatched?: boolean
  } | null
  explorationRoute?: {
    path?: string | null
    selectors?: string[]
    keyFlows?: unknown[]
  } | null
  trace?: {
    failedAction?: {
      name?: string
      selector?: string | null
      url?: string | null
      errorText?: string
    } | null
    domAtFailure?: {
      bodyTextSample?: string
      visibleButtons?: string[]
      visibleInputs?: string[]
    } | null
    networkAtFailure?: Array<{ url: string; method: string; status: number; duration: number }>
    consoleAtFailure?: string[]
    parseError?: string | null
  } | null
  classifierVerdict?: {
    verdict: Verdict
    confidence: number
    reason: string
    ruleId?: number
  } | null
}

export const TEST_TRIAGE_SYSTEM_PROMPT = `You are a failure-triage analyst for Healix, a test automation platform. You receive a structured evidence bundle for one failed Playwright test and must commit to ONE of four verdicts, with confidence and a concrete remediation.

## Verdicts

- "test_is_wrong"   — the GENERATED TEST is buggy (hallucinated selector, misread acceptance criterion, wrong auth context).
- "app_is_wrong"    — the APPLICATION has a real regression (missing button, 500 response, assertion mismatch on text that contradicts the AC).
- "environment"     — infra issue (dev server down, flaky resource, auth seed expired).
- "ambiguous"       — evidence is insufficient — surface both hypotheses for human review.

## ANTI-BIAS CLAUSE (READ CAREFULLY)

Your first instinct should NOT be to fix the test. Before returning "test_is_wrong", explicitly verify at least ONE of:
  (a) the selector the test uses is NOT present in the "explorationRoute.selectors" you're given, OR
  (b) the test's assertion literally contradicts the acceptanceCriterion.text you're given.
If neither holds, prefer "app_is_wrong" or "ambiguous". State the verification in your "reason" field.

## PATCH GUARDRAIL

Any "suggestedPatch" you propose MUST:
  1. Preserve the \`[REQ:...]\` tag in the test title — do NOT rename or remove it.
  2. Contain at least one \`expect(...)\` call that still verifies the AC.
  3. Match code that actually appears in the "testSource" verbatim (no paraphrasing).

Set "preservesRequirementTag" honestly — the consumer will re-verify, so lying earns nothing. If you cannot satisfy all three constraints, return "suggestedPatch": null and leave the patch for a human.

## Output shape

Return ONLY a single JSON object with this exact structure:

{
  "verdict": "test_is_wrong" | "app_is_wrong" | "environment" | "ambiguous",
  "verdictConfidence": 0.0,
  "fixTarget": "test" | "app" | "env" | "none",
  "reason": "1-2 sentence explanation that REFERENCES specific evidence fields (e.g. 'trace.failedAction.selector \\'Buy now\\' not in explorationRoute.selectors').",
  "suggestedPatch": {
    "file": "tests/generated/...",
    "lineStart": 1,
    "lineEnd": 1,
    "oldCode": "...",
    "newCode": "...",
    "preservesRequirementTag": true
  } | null,
  "alternativeHypothesis": "One sentence: what would have to be true for the OTHER verdict to be right?",
  "evidenceUsed": ["trace.failedAction.selector", "acceptanceCriterion.text", ...],
  "analysis": "2-4 sentences that walk through the reasoning.",
  "rootCause": "One phrase root cause.",
  "testingRecommendations": "How to verify the fix works."
}

Ground EVERY claim in evidence fields provided. Never invent selectors, URLs, or AC text. Return ONLY the JSON object — no markdown fences.`

/**
 * Render a single evidence bundle into a user prompt. Keep each section short
 * and explicitly labeled so the model can cite fields back in `evidenceUsed`.
 */
export function buildTestTriagePrompt(bundle: EvidenceBundle): string {
  const parts: string[] = []

  parts.push('# Failure Evidence')
  parts.push('')
  parts.push('## Test')
  parts.push(`- Title: ${bundle.testName || '(unknown)'}`)
  parts.push(`- File: ${bundle.file || '(unknown)'}`)
  parts.push(`- Tier/role: ${bundle.tier || '(unknown)'} / ${bundle.role || 'n/a'}`)
  parts.push(`- Status: ${bundle.status || 'failed'}`)
  parts.push('')

  parts.push('## Error')
  parts.push('```')
  parts.push(bundle.error?.message || '(no error message)')
  parts.push('```')
  parts.push('')

  if (bundle.testSource) {
    parts.push('## testSource (the failing test block)')
    parts.push('```ts')
    parts.push(bundle.testSource)
    parts.push('```')
    parts.push('')
  }

  if (bundle.acceptanceCriterion) {
    const ac = bundle.acceptanceCriterion
    parts.push('## acceptanceCriterion')
    parts.push(`- Tag: ${ac.tag || '(none)'}`)
    parts.push(`- Text: ${ac.text || '(unmatched — PRD stale)'}`)
    parts.push(`- authRequired: ${ac.authRequired ? 'true' : 'false'}`)
    if (ac.unmatched) parts.push('- NOTE: AC text could not be resolved from parsed PRD. Treat with caution.')
    parts.push('')
  }

  if (bundle.explorationRoute) {
    const r = bundle.explorationRoute
    parts.push('## explorationRoute (what exploration saw on this URL)')
    parts.push(`- Path: ${r.path || '(unknown)'}`)
    if (Array.isArray(r.selectors) && r.selectors.length) {
      parts.push('- Selectors exploration recorded:')
      r.selectors.slice(0, 18).forEach((s) => parts.push(`  - ${s}`))
    } else {
      parts.push('- Selectors: (none recorded — exploration did not cover this route)')
    }
    parts.push('')
  }

  if (bundle.trace) {
    const t = bundle.trace
    parts.push('## trace')
    if (t.failedAction) {
      parts.push(`- failedAction.name: ${t.failedAction.name || '(unknown)'}`)
      parts.push(`- failedAction.selector: ${t.failedAction.selector || '(none)'}`)
      parts.push(`- failedAction.url: ${t.failedAction.url || '(none)'}`)
      parts.push(`- failedAction.errorText: ${t.failedAction.errorText || '(none)'}`)
    }
    if (t.domAtFailure?.bodyTextSample) {
      parts.push('- domAtFailure.bodyTextSample:')
      parts.push(`  ${t.domAtFailure.bodyTextSample}`)
    }
    if (Array.isArray(t.domAtFailure?.visibleButtons) && t.domAtFailure!.visibleButtons!.length) {
      parts.push(`- domAtFailure.visibleButtons: ${t.domAtFailure!.visibleButtons!.slice(0, 10).join(' | ')}`)
    }
    if (Array.isArray(t.networkAtFailure) && t.networkAtFailure.length) {
      parts.push('- networkAtFailure (last):')
      t.networkAtFailure.slice(0, 6).forEach((r) =>
        parts.push(`  - ${r.method} ${r.url} → ${r.status} (${r.duration}ms)`),
      )
    }
    if (Array.isArray(t.consoleAtFailure) && t.consoleAtFailure.length) {
      parts.push('- consoleAtFailure:')
      t.consoleAtFailure.slice(0, 5).forEach((line) => parts.push(`  - ${line}`))
    }
    if (t.parseError) parts.push(`- trace.parseError: ${t.parseError}`)
    parts.push('')
  }

  if (bundle.classifierVerdict) {
    const c = bundle.classifierVerdict
    parts.push('## classifierVerdict (deterministic pre-verdict — this run reached AI because the rules were inconclusive)')
    parts.push(`- verdict: ${c.verdict}  confidence: ${c.confidence}  reason: ${c.reason}  ruleId: ${c.ruleId ?? 'n/a'}`)
    parts.push('')
  }

  parts.push('## Task')
  parts.push('Commit to ONE verdict and return the JSON specified in the system prompt.')
  parts.push('If you return "test_is_wrong", explicitly prove the selector is not in explorationRoute.selectors OR that the assertion contradicts the AC.')

  return parts.join('\n')
}

/**
 * Verify a model-proposed patch meets the auto-apply guardrail. MCP calls this
 * before auto-applying, but we also check server-side so our response reflects
 * realistic auto_apply eligibility.
 *
 * Returns { ok, reason } — ok means the patch preserves [REQ:] in the title AND
 * the newCode contains at least one expect(. If either fails, the consumer
 * downgrades the patch to surface_for_approval.
 */
export function validatePatchGuardrail(
  patch: SuggestedPatch | null,
  testSource: string | null | undefined,
): { ok: boolean; reason?: string } {
  if (!patch) return { ok: false, reason: 'no_patch' }
  if (!testSource) return { ok: false, reason: 'no_test_source' }

  const reqMatch = /\[REQ:[A-Za-z0-9.]+\]/
  const titleHasReq = reqMatch.test(testSource)
  if (!titleHasReq) return { ok: false, reason: 'source_missing_req_tag' }

  if (reqMatch.test(patch.oldCode) && !reqMatch.test(patch.newCode)) {
    return { ok: false, reason: 'patch_removes_req_tag' }
  }

  if (!/\bexpect\s*\(/.test(patch.newCode) && !/\bexpect\s*\(/.test(testSource)) {
    return { ok: false, reason: 'patch_has_no_expect' }
  }

  if (!testSource.includes(patch.oldCode)) {
    return { ok: false, reason: 'patch_oldCode_not_in_source' }
  }

  return { ok: true }
}

/**
 * Decide whether a bundle is an "evidence bundle" (new shape from
 * evidence-bundler) vs. a legacy `{ testName, error }` payload. The route
 * keeps back-compat with the old shape.
 */
export function isEvidenceBundle(failure: unknown): failure is EvidenceBundle {
  if (!failure || typeof failure !== 'object') return false
  const f = failure as Record<string, unknown>
  if (f.kind !== 'test') return false
  return 'trace' in f || 'acceptanceCriterion' in f || 'explorationRoute' in f || 'classifierVerdict' in f
}
