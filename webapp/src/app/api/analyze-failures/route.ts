import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { deductCredit } from '@/lib/credits'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateAnalyzeFailures } from '@/lib/validation'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/analyze-failures'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'
const FALLBACK_MODEL = 'gpt-4o'
const OPENAI_MAX_TOKENS = 4000
const OPENAI_TEMPERATURE = 0.2
const OPENAI_TIMEOUT = 180_000 // 3 minutes

const MAX_FAILURES = 8

// ── OpenAI Chat Completions call (with model fallback) ───────────────
async function callOpenAIWithModel(
  messages: Array<{ role: string; content: string }>,
  model: string,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: OPENAI_TEMPERATURE,
        max_tokens: OPENAI_MAX_TOKENS,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`)
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  } catch (error: unknown) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('OpenAI request timed out (3 min)')
    throw error
  }
}

async function callOpenAI(messages: Array<{ role: string; content: string }>) {
  try {
    return await callOpenAIWithModel(messages, OPENAI_MODEL)
  } catch (error) {
    if (
      OPENAI_MODEL !== FALLBACK_MODEL &&
      error instanceof Error &&
      (error.message.includes('does not exist') || error.message.includes('model_not_found'))
    ) {
      console.warn(`[analyze-failures] Model "${OPENAI_MODEL}" failed, falling back to "${FALLBACK_MODEL}"`)
      return await callOpenAIWithModel(messages, FALLBACK_MODEL)
    }
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

    // 8. Credit gate — atomic decrement, fail-closed (throws on DB error)
    const creditResult = await deductCredit({ userId, endpoint: ENDPOINT })
    if (!creditResult.allowed) {
      return NextResponse.json({ error: 'No credits remaining' }, { status: 402 })
    }

    // Update last_used_at and record AI call
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    await recordAiCall({ userId, apiKeyId: apiKeyRecord.id, endpoint: ENDPOINT })

    // Cap failures to max limit
    const cappedFailures = failures.slice(0, MAX_FAILURES)

    // 6. Analyze each failure
    const analyses = await Promise.all(
      cappedFailures.map(async (failure: {
        testName?: string
        file?: string
        status?: string
        duration?: number
        error?: { message?: string; stack?: string }
      }) => {
        try {
          const raw = await callOpenAI([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(failure) },
          ])

          const parsed = parseAnalysis(raw)

          return {
            failure: {
              testName: failure.testName,
              file: failure.file,
              status: failure.status,
              duration: failure.duration,
            },
            ...parsed,
          }
        } catch (err) {
          console.error(`[analyze-failures] Failed to analyze ${failure.testName}:`, err)
          return {
            failure: {
              testName: failure.testName,
              file: failure.file,
              status: failure.status,
              duration: failure.duration,
            },
            analysis: 'Failed to analyze this failure',
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

    const responseBody = { success: true, analyses }

    // 9. Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult({ idempotencyKey, userId, endpoint: ENDPOINT, responseBody })
    }

    // 10. Async abuse detection (non-blocking)
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch(() => undefined)

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[analyze-failures] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
