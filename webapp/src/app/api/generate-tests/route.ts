import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { OpenAITestGenerator } from '@/lib/test-generation/openai-generator'
import type { CapturedContext, GenerationOptions, ProjectInfo } from '@/lib/test-generation/types'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance, deductTokens } from '@/lib/tokens'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateGenerateTests } from '@/lib/validation'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/generate-tests'

// ── Main POST handler ─────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // 0. Validate server-side key exists
    if (!process.env.OPENAI_API_KEY) {
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

    // 4. Concurrency limit check
    const concurrencyResult = await checkConcurrencyLimit({ userId, endpoint: ENDPOINT })
    if (!concurrencyResult.allowed) {
      return NextResponse.json({ error: 'CONCURRENT_LIMIT_EXCEEDED' }, { status: 429 })
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
    const validationError = validateGenerateTests(body)
    if (validationError) {
      return NextResponse.json(validationError, { status: 422 })
    }

    // 7. AI cost guard
    const aiGuardResult = await checkAiGuard({ userId, endpoint: ENDPOINT })
    if (!aiGuardResult.allowed) {
      return NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429 })
    }

    // 8. Token balance gate — check before making AI calls
    const tokenCheck = await checkTokenBalance({ userId, endpoint: ENDPOINT })
    if (!tokenCheck.allowed) {
      return NextResponse.json({ error: 'No tokens remaining. Please renew your plan.' }, { status: 402 })
    }

    // Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    // Business logic
    const { context, testType, prd, projectInfo, options } = body

    const ctx = (context || {}) as CapturedContext
    const info = (projectInfo || {}) as ProjectInfo
    const type = (testType || 'both') as 'frontend' | 'backend' | 'both'
    const prdContent = (prd || '') as string
    const genOptions = (options || {}) as GenerationOptions

    const generator = new OpenAITestGenerator({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      fallbackOnFailure: genOptions.strictAIGeneration !== true,
      enforceValidation: true,
      syntaxValidationMode: 'fail-open',
      strictAIGeneration: genOptions.strictAIGeneration === true,
    })

    const generatedFiles = await generator.generateTests({
      context: ctx,
      prd: prdContent,
      testType: type,
      projectInfo: info,
      options: genOptions,
    })

    const summary = generator.getSummary()

    // Deduct actual tokens consumed and record AI call
    const tokensConsumed = summary.tokenUsage.totalTokens
    if (tokensConsumed > 0) {
      await deductTokens({ userId, tokensUsed: tokensConsumed })
      await recordAiCall({
        userId,
        apiKeyId: apiKeyRecord.id,
        endpoint: ENDPOINT,
        modelUsed: summary.tokenUsage.modelUsed ?? undefined,
        tokensPrompt: summary.tokenUsage.promptTokens,
        tokensCompletion: summary.tokenUsage.completionTokens,
        tokensTotal: tokensConsumed,
      })
    }

    const responseBody = {
      success: true,
      tests: generatedFiles,
      count: generatedFiles.length,
      generationMeta: summary.generationMeta,
      byType: summary.byType,
    }

    // 9. Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult({ idempotencyKey, userId, endpoint: ENDPOINT, responseBody })
    }

    // 10. Async abuse detection (non-blocking)
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch(() => undefined)

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[generate-tests] error:', error)
    const errCode = (error as NodeJS.ErrnoException).code
    const status =
      errCode === 'OPENAI_KEY_MISSING'
        ? 503
        : errCode === 'AI_GENERATION_INSUFFICIENT' || errCode === 'MIN_TEST_COUNT_NOT_MET' || errCode === 'COVERAGE_GATES_FAILED'
          ? 422
          : 500
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
        code: errCode || null,
      },
      { status },
    )
  }
}
