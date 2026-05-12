import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance, recordTokenUsage, MIN_TOKENS_ANALYZE, REC_TOKENS_ANALYZE } from '@/lib/tokens'
import { resolveModel } from '@/lib/pricing'
import { resolveConfiguredOpenAIModel, resolveProviderOpenAIModel } from '@/lib/model-defaults'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateAnalyzeFailures } from '@/lib/validation'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { logBlockedRequest } from '@/lib/security-logger'
import {
  TEST_TRIAGE_SYSTEM_PROMPT,
  buildTestTriagePrompt,
  isEvidenceBundle,
  validatePatchGuardrail,
  type EvidenceBundle,
  type SuggestedPatch,
} from '@/lib/triage/prompt'

const ENDPOINT = '/api/analyze-failures'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = resolveConfiguredOpenAIModel()
// gpt-5.5-mini with reasoning:high can run 5+ minutes on evidence-heavy triage.
const OPENAI_TIMEOUT = 540_000 // 9 minutes

const MAX_FAILURES = 8

// ── OpenAI Responses API call ────────────────────────────────────────
interface OpenAICallResult {
  text: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  modelUsed: string
}

function messagesToResponsesInput(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map((m) => `${String(m.role || 'user').toUpperCase()}:\n${String(m.content || '').trim()}`)
    .join('\n\n')
}

function extractResponsesText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const p = data as Record<string, unknown>
  if (typeof p.output_text === 'string' && p.output_text.trim()) return p.output_text.trim()
  if (Array.isArray(p.output)) {
    const chunks: string[] = []
    for (const item of p.output) {
      const content = Array.isArray((item as Record<string, unknown>)?.content)
        ? ((item as Record<string, unknown>).content as unknown[])
        : []
      for (const part of content) {
        const partObj = part as Record<string, unknown>
        if (typeof partObj?.text === 'string' && partObj.text.trim()) chunks.push(partObj.text.trim())
      }
    }
    if (chunks.length) return chunks.join('\n').trim()
  }
  return ''
}

async function callOpenAI(messages: Array<{ role: string; content: string }>): Promise<OpenAICallResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT)

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: resolveProviderOpenAIModel(OPENAI_MODEL),
        input: messagesToResponsesInput(messages),
        reasoning: { effort: 'high' },
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`)
    }

    const data = await res.json()
    const text = extractResponsesText(data)
    const usage = (data.usage ?? {}) as Record<string, number>
    const promptTokens = usage.input_tokens ?? 0
    const completionTokens = usage.output_tokens ?? 0
    return {
      text,
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
      modelUsed: OPENAI_MODEL,
    }
  } catch (error: unknown) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('OpenAI request timed out (3 min)')
    throw error
  }
}

// ── Parse AI analysis JSON from GPT response ─────────────────────────
function parseAnalysis(raw: string) {
  const content = raw.trim()

  // Try direct JSON parse
  try {
    return JSON.parse(content)
  } catch {
    // continue
  }

  // Try extracting from markdown code blocks
  const md = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (md) {
    try {
      return JSON.parse(md[1])
    } catch {
      // continue
    }
  }

  // Try regex for JSON object
  const obj = content.match(/(\{[\s\S]*\})/)
  if (obj) {
    try {
      return JSON.parse(obj[1])
    } catch {
      // continue
    }
  }

  // Fallback error object
  return {
    analysis: 'Failed to parse AI response',
    rootCause: 'Unknown',
    fix: { description: 'Unable to generate fix', changes: [] },
    confidence: 0,
    affectedFiles: [],
    testingRecommendations: 'Manual investigation required',
    parseError: true,
    rawResponse: content.substring(0, 500),
  }
}

// ── System prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert software testing and debugging assistant. Analyze test failures and provide precise fixes in JSON format.

Your response MUST be a valid JSON object with this exact structure:
{
  "analysis": "Detailed explanation of what caused the failure",
  "rootCause": "Root cause of the issue",
  "fix": {
    "description": "Clear description of the fix",
    "changes": [
      {
        "file": "path/to/file.js",
        "action": "replace",
        "lineStart": 10,
        "lineEnd": 15,
        "oldCode": "current code to replace",
        "newCode": "fixed code"
      }
    ]
  },
  "confidence": 0.95,
  "affectedFiles": ["path/to/file.js"],
  "testingRecommendations": "How to verify the fix works"
}

IMPORTANT: Return ONLY the JSON object, no markdown formatting.`

// ── Build user prompt for a single failure ───────────────────────────
function buildUserPrompt(failure: {
  testName?: string
  file?: string
  status?: string
  duration?: number
  error?: { message?: string; stack?: string }
}) {
  return `# Test Failure Analysis Request

## Test Details
- **Test Name**: ${failure.testName}
- **File Path**: ${failure.file}
- **Status**: ${failure.status}
- **Duration**: ${failure.duration}ms

## Error Message
\`\`\`
${failure.error?.message || 'No error message'}
\`\`\`

## Stack Trace (if available)
\`\`\`
${failure.error?.stack || 'No stack trace'}
\`\`\`

## Task
Analyze this test failure and provide a fix. Focus on:
1. Identifying the root cause
2. Providing exact code changes needed
3. Ensuring the fix is minimal and targeted
4. Assigning a confidence score (0.0 to 1.0)

Return your analysis as a JSON object.`
}

// ── Pipeline-error prompt — whole run never executed because generation broke ───
interface PipelineFailureInput {
  kind: 'pipeline'
  stage?: string
  reason?: string | null
  stderr?: string | null
  stdout?: string | null
  firstSpecPreview?: { file?: string; lines?: string } | null
  generatedSpecCount?: number
  qualityAuditErrors?: string[] | null
  errorCode?: string | null
  userFacingMessage?: string | null
}

function isPipelineFailure(failure: unknown): failure is PipelineFailureInput {
  return !!failure && typeof failure === 'object' && (failure as { kind?: string }).kind === 'pipeline'
}

function truncate(value: unknown, max = 3000): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) + `\n… (${value.length - max} more chars truncated)` : value
}

const PIPELINE_SYSTEM_PROMPT = `You are an expert CI/CD and test-runner debugging assistant. The Healix pipeline failed BEFORE any test could run — there is no per-test failure, only a pipeline-level diagnostic. Your job is to classify which layer is at fault and emit a concrete remediation.

Return a single JSON object with this exact shape:
{
  "verdict": "pipeline_error",
  "fixTarget": "test_generation" | "test_runner_config" | "dependencies" | "env" | "app" | "unknown",
  "rootCause": "One-sentence plain-English root cause, grounded in the stderr or spec preview provided.",
  "analysis": "2-4 sentence explanation. Quote the specific stderr line or spec snippet that justifies your call.",
  "fix": {
    "description": "Exact remediation a developer can execute.",
    "changes": [
      { "file": "path/or/command", "action": "run" | "edit" | "install", "command": "npm install …" | null, "oldCode": null, "newCode": null }
    ]
  },
  "confidence": 0.0,
  "affectedFiles": [],
  "testingRecommendations": "How to verify the pipeline now runs."
}

Classification rules:
- "cannot find module" / "Cannot find package '@playwright/test'" → fixTarget: "dependencies", suggest install.
- "SyntaxError" / "Unexpected token" inside a generated spec → fixTarget: "test_generation", propose regenerating or patching the specific spec.
- "testDir" / "no tests found" / config-parsing errors → fixTarget: "test_runner_config".
- "ECONNREFUSED" / "server didn't respond" on startup → fixTarget: "env".
- If the stderr is inconclusive, confidence ≤ 0.5 and ask for a re-run with --debug.

Ground EVERY claim in the stderr or spec text provided. Never invent error messages. Return ONLY the JSON object.`

function buildPipelinePrompt(failure: PipelineFailureInput) {
  const stderr = truncate(failure.stderr, 3500)
  const spec = failure.firstSpecPreview?.lines ? truncate(failure.firstSpecPreview.lines, 2500) : ''
  const qa = (failure.qualityAuditErrors || []).slice(0, 8).map((s, i) => `  ${i + 1}. ${s}`).join('\n')

  return `# Healix Pipeline Failure

## Context
- **Stage**: ${failure.stage || 'unknown'}
- **Reason code**: ${failure.reason || 'unknown'}
- **Error code**: ${failure.errorCode || 'none'}
- **Generated spec count**: ${failure.generatedSpecCount ?? 'unknown'}
${failure.userFacingMessage ? `- **User-facing summary**: ${failure.userFacingMessage}` : ''}

## Playwright stderr
\`\`\`
${stderr || '(no stderr captured)'}
\`\`\`

${qa ? `## Quality audit errors\n${qa}\n` : ''}
${spec ? `## First generated spec preview (${failure.firstSpecPreview?.file || 'unknown'})\n\`\`\`ts\n${spec}\n\`\`\`\n` : ''}

## Task
Classify which layer broke (test generation / runner config / dependencies / env / app) and emit a concrete fix. Return the JSON object specified in the system prompt.`
}

// ── Main POST handler ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // 0. Validate server-side key exists
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Server OpenAI key not configured' }, { status: 503 })
    }

    // 1. API key presence check (header or body)
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const api_key: string = rawKey ?? body?.api_key ?? ''

    if (!api_key) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const { failures } = body

    if (!failures || !Array.isArray(failures) || failures.length === 0) {
      return NextResponse.json({ error: 'Missing or empty failures array' }, { status: 400 })
    }

    // 2. Authenticate — validate key, check isActive and NOT revoked, check expiry
    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    // 3. Rate limit check
    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    // 5. Idempotency check
    const idempotencyKey = request.headers.get('x-idempotency-key')
    if (idempotencyKey) {
      const idempotencyResult = await checkIdempotency({ idempotencyKey, userId, endpoint: ENDPOINT })
      if (idempotencyResult.isDuplicate) {
        return NextResponse.json(idempotencyResult.cachedBody)
      }
    }

    // 6. Input validation
    const validationError = validateAnalyzeFailures(body, userId, ENDPOINT)
    if (validationError) {
      return NextResponse.json(validationError, { status: 422 })
    }

    // 7. AI cost guard
    const aiGuardResult = await checkAiGuard({ userId, endpoint: ENDPOINT })
    if (!aiGuardResult.allowed) {
      return NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429 })
    }

    // 8. Token balance gate — check before making AI calls
    const tokenCheck = await checkTokenBalance({ userId, endpoint: ENDPOINT, minRequired: MIN_TOKENS_ANALYZE, recommended: REC_TOKENS_ANALYZE })
    if (!tokenCheck.allowed) {
      return NextResponse.json({ error: tokenCheck.reason }, { status: 402 })
    }

    // Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // Cap failures to max limit
    const cappedFailures = failures.slice(0, MAX_FAILURES)

    // 6. Analyze each failure — accumulate token usage across all parallel calls
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalTokensConsumed = 0
    let lastModelUsed = OPENAI_MODEL

    const analyses = await Promise.all(
      cappedFailures.map(async (failure: unknown) => {
        const isPipeline = isPipelineFailure(failure)
        const isEvidence = !isPipeline && isEvidenceBundle(failure)

        let messages: Array<{ role: string; content: string }>
        if (isPipeline) {
          messages = [
            { role: 'system', content: PIPELINE_SYSTEM_PROMPT },
            { role: 'user', content: buildPipelinePrompt(failure as PipelineFailureInput) },
          ]
        } else if (isEvidence) {
          messages = [
            { role: 'system', content: TEST_TRIAGE_SYSTEM_PROMPT },
            { role: 'user', content: buildTestTriagePrompt(failure as EvidenceBundle) },
          ]
        } else {
          messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(failure as {
              testName?: string; file?: string; status?: string; duration?: number; error?: { message?: string; stack?: string }
            }) },
          ]
        }

        const failureMeta = isPipeline
          ? {
              kind: 'pipeline' as const,
              testName: `[PIPELINE] ${(failure as PipelineFailureInput).stage || 'unknown'}`,
              file: (failure as PipelineFailureInput).firstSpecPreview?.file || null,
              status: 'pipeline_error',
              duration: 0,
            }
          : isEvidence
          ? {
              kind: 'test' as const,
              testName: (failure as EvidenceBundle).testName,
              file: (failure as EvidenceBundle).file ?? null,
              status: (failure as EvidenceBundle).status,
              duration: (failure as EvidenceBundle).duration,
              tier: (failure as EvidenceBundle).tier ?? null,
              role: (failure as EvidenceBundle).role ?? null,
            }
          : {
              kind: 'test' as const,
              testName: (failure as { testName?: string }).testName,
              file: (failure as { file?: string }).file,
              status: (failure as { status?: string }).status,
              duration: (failure as { duration?: number }).duration,
            }

        try {
          const result = await callOpenAI(messages)

          totalPromptTokens += result.promptTokens
          totalCompletionTokens += result.completionTokens
          totalTokensConsumed += result.totalTokens
          lastModelUsed = result.modelUsed

          const parsed = parseAnalysis(result.text)

          // For evidence bundles, server-side re-verify the patch guardrail so
          // the downstream agent can trust `auto_apply_eligible`. Model flags
          // are advisory, never load-bearing.
          if (isEvidence && parsed && typeof parsed === 'object') {
            const bundle = failure as EvidenceBundle
            const patch = (parsed as { suggestedPatch?: SuggestedPatch | null }).suggestedPatch ?? null
            const guard = validatePatchGuardrail(patch, bundle.testSource || null)
            ;(parsed as { auto_apply_eligible?: boolean }).auto_apply_eligible =
              guard.ok && (parsed as { verdictConfidence?: number }).verdictConfidence != null
                ? Number((parsed as { verdictConfidence?: number }).verdictConfidence) >= 0.85
                : false
            ;(parsed as { guardrail?: { ok: boolean; reason?: string } }).guardrail = guard
          }

          return { failure: failureMeta, ...parsed }
        } catch (err) {
          console.error(`[analyze-failures] Failed to analyze ${failureMeta.testName}:`, err)
          return {
            failure: failureMeta,
            analysis: isPipeline
              ? 'Failed to analyze pipeline error — check server logs.'
              : 'Failed to analyze this failure',
            rootCause: 'Analysis error',
            fix: { description: 'Unable to generate fix', changes: [] },
            confidence: 0,
            affectedFiles: [],
            testingRecommendations: 'Manual investigation required',
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      }),
    )

    // Deduct actual tokens consumed and record AI call
    if (totalTokensConsumed > 0) {
      await recordTokenUsage({
        userId,
        endpoint: ENDPOINT,
        agent: 'analyze_failures',
        model: resolveModel(lastModelUsed),
        tokensInput:  totalPromptTokens,
        tokensOutput: totalCompletionTokens,
        referenceType: 'analyze_failures',
        referenceId: null,
      })
      await recordAiCall({
        userId,
        apiKeyId: apiKeyRecord.id,
        endpoint: ENDPOINT,
        modelUsed: resolveModel(lastModelUsed),
        tokensPrompt: totalPromptTokens,
        tokensCompletion: totalCompletionTokens,
        tokensTotal: totalTokensConsumed,
        agent: 'analyze_failures',
      })
    }

    const responseBody = {
      success: true,
      analyses,
      tokenUsage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalTokensConsumed,
        modelUsed: lastModelUsed,
      },
    }

    // 9. Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult({ idempotencyKey, userId, endpoint: ENDPOINT, responseBody })
    }

    // 10. Async abuse detection (non-blocking)
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch((err: unknown) => {
      console.error('[analyze-failures] abuse detection failed', err)
    })

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[analyze-failures] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
