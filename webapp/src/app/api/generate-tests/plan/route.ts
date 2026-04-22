import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { apiKeys, generationPlans } from '@/lib/db/schema'
import { eq, and, gt, sql } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { planFrontend, planBackend } from '@/lib/test-generation/planner-agent'
import type {
  CapturedContext,
  GenerationOptions,
  ProjectInfo,
  ParsedPRD,
  ExplorationArtifact,
  Role,
} from '@/lib/test-generation/types'
import {
  CURRENT_PLAN_VERSION,
  type GenerationPlan,
  type FrontendPlan,
  type BackendPlan,
  type PlanWarning,
} from '@/lib/test-generation/plan-schema'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance, deductTokens } from '@/lib/tokens'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/generate-tests/plan'

// Matches the sibling generate-tests route — 60s Vercel Hobby ceiling. The
// planner itself uses a 30s timeout per call, so two parallel planners plus
// bookkeeping comfortably fit under 60s.
export const maxDuration = 60

function canonicalJSON(value: unknown): string {
  // Stable stringify: sort object keys recursively so the hash is
  // insensitive to key order across client versions.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function computePlanHash(parts: {
  prd: string
  parsedPRD: ParsedPRD | null
  contextDigest: unknown
  projectInfoDigest: unknown
  roles: Role[]
}): string {
  return sha256Hex(canonicalJSON(parts))
}

function buildContextDigest(ctx: CapturedContext) {
  return {
    pageCount: (ctx.pages || []).length,
    endpointCount: (ctx.apiEndpoints || []).length,
    pageSample: (ctx.pages || []).slice(0, 5).map((p) => p.path),
  }
}

function buildProjectInfoDigest(info: ProjectInfo) {
  return {
    name: info.name || null,
    framework: info.framework || null,
    apiOnly: info.apiOnly === true,
    testType: getTestType(info),
  }
}

// `testType` is a soft hint the caller can pass in projectInfo to narrow
// the planner to just the frontend or backend axis. It's not part of the
// formal ProjectInfo type (which is shared with the test generator) so we
// read it dynamically.
function getTestType(info: ProjectInfo): string | null {
  const anyInfo = info as unknown as Record<string, unknown>
  const tt = anyInfo.testType
  return typeof tt === 'string' ? tt : null
}

function totalPlannedTests(fe: FrontendPlan | null, be: BackendPlan | null): number {
  return (fe?.plannedTests ?? 0) + (be?.plannedTests ?? 0)
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { success: false, fallback: 'rule_based', reason: 'OPENAI_KEY_MISSING' },
        { status: 200 },
      )
    }

    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const api_key: string = rawKey ?? body?.api_key ?? ''

    if (!api_key) {
      logBlockedRequest({
        type: 'MISSING_API_KEY',
        reason: 'No x-api-key header or api_key body field',
        endpoint: ENDPOINT,
      })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        isActive: apiKeys.isActive,
        revoked: apiKeys.revoked,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({
        type: 'INVALID_API_KEY',
        reason: 'Key not found or inactive',
        endpoint: ENDPOINT,
      })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({
        type: 'REVOKED_API_KEY',
        user_id: apiKeyRecord.userId,
        reason: 'API key has been revoked',
        endpoint: ENDPOINT,
      })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({
        type: 'EXPIRED_API_KEY',
        user_id: apiKeyRecord.userId,
        reason: 'API key has expired',
        endpoint: ENDPOINT,
      })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } },
      )
    }

    const concurrencyResult = await checkConcurrencyLimit({ userId, endpoint: ENDPOINT })
    if (!concurrencyResult.allowed) {
      return NextResponse.json({ error: 'CONCURRENT_LIMIT_EXCEEDED' }, { status: 429 })
    }

    const idempotencyKey = request.headers.get('x-idempotency-key')
    if (idempotencyKey) {
      const idempotencyResult = await checkIdempotency({
        idempotencyKey,
        userId,
        endpoint: ENDPOINT,
      })
      if (idempotencyResult.isDuplicate) {
        return NextResponse.json(idempotencyResult.cachedBody)
      }
    }

    const aiGuardResult = await checkAiGuard({ userId, endpoint: ENDPOINT })
    if (!aiGuardResult.allowed) {
      return NextResponse.json({ error: 'RATE_LIMIT_EXCEEDED' }, { status: 429 })
    }

    const tokenCheck = await checkTokenBalance({ userId, endpoint: ENDPOINT })
    if (!tokenCheck.allowed) {
      return NextResponse.json(
        { error: 'No tokens remaining. Please renew your plan.' },
        { status: 402 },
      )
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    const {
      context,
      prd,
      parsedPRD,
      explorationArtifact,
      roles,
      projectInfo,
      options,
      apiOnly: apiOnlyBody,
    } = body as {
      context?: CapturedContext
      prd?: string
      parsedPRD?: ParsedPRD | null
      explorationArtifact?: ExplorationArtifact | null
      roles?: Role[]
      projectInfo?: ProjectInfo
      options?: GenerationOptions
      apiOnly?: boolean
    }

    const ctx = (context || {}) as CapturedContext
    const info = (projectInfo || {}) as ProjectInfo
    const prdContent = (prd || '') as string
    const parsedPRDInput = (parsedPRD || null) as ParsedPRD | null
    const explorationInput = (explorationArtifact || null) as ExplorationArtifact | null
    const rolesInput = Array.isArray(roles) ? (roles as Role[]) : []
    const _opts = (options || {}) as GenerationOptions
    void _opts

    const planHash = computePlanHash({
      prd: prdContent,
      parsedPRD: parsedPRDInput,
      contextDigest: buildContextDigest(ctx),
      projectInfoDigest: buildProjectInfoDigest(info),
      roles: rolesInput,
    })

    // Cache lookup — last 24h. Only user-scoped; no cross-tenant reuse.
    try {
      const twentyFourHoursAgo = sql`now() - interval '24 hours'`
      const [cached] = await db
        .select({ planJson: generationPlans.planJson })
        .from(generationPlans)
        .where(
          and(
            eq(generationPlans.userId, userId),
            eq(generationPlans.planHash, planHash),
            gt(generationPlans.createdAt, twentyFourHoursAgo as unknown as Date),
          ),
        )
        .limit(1)

      if (cached?.planJson) {
        const cachedPlan = cached.planJson as GenerationPlan
        const hitBody = { success: true, plan: cachedPlan, cache: 'hit' as const, plannerTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
        if (idempotencyKey) {
          await storeIdempotencyResult({
            idempotencyKey,
            userId,
            endpoint: ENDPOINT,
            responseBody: hitBody,
          })
        }
        return NextResponse.json(hitBody)
      }
    } catch (cacheErr) {
      // Cache lookup is best-effort; a DB blip shouldn't block plan generation.
      console.warn('[generate-tests/plan] cache lookup failed', cacheErr)
    }

    const testType = getTestType(info) || (apiOnlyBody ? 'backend' : null)
    const runFrontend = !apiOnlyBody && testType !== 'backend'
    const runBackend = apiOnlyBody || testType !== 'frontend'

    const planCtx = {
      context: ctx,
      prdContent,
      parsedPRD: parsedPRDInput,
      explorationArtifact: explorationInput,
      projectInfo: info,
      roles: rolesInput,
      options: _opts,
    }

    let frontendPlan: FrontendPlan | null = null
    let backendPlan: BackendPlan | null = null
    const warnings: PlanWarning[] = []
    let plannerTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    try {
      const [feResult, beResult] = await Promise.all([
        runFrontend ? planFrontend(planCtx) : Promise.resolve(null),
        runBackend ? planBackend(planCtx) : Promise.resolve(null),
      ])
      if (feResult) {
        frontendPlan = feResult.plan
        warnings.push(...feResult.warnings)
      }
      if (beResult) {
        backendPlan = beResult.plan
        warnings.push(...beResult.warnings)
      }

      const plannerPrompt = (feResult?.tokenUsage.promptTokens ?? 0) + (beResult?.tokenUsage.promptTokens ?? 0)
      const plannerCompletion = (feResult?.tokenUsage.completionTokens ?? 0) + (beResult?.tokenUsage.completionTokens ?? 0)
      const plannerTotal = plannerPrompt + plannerCompletion
      plannerTokens = { promptTokens: plannerPrompt, completionTokens: plannerCompletion, totalTokens: plannerTotal }
      if (plannerTotal > 0) {
        try {
          await deductTokens({ userId, tokensUsed: plannerTotal })
          await recordAiCall({
            userId,
            apiKeyId: apiKeyRecord.id,
            endpoint: ENDPOINT,
            modelUsed: 'gpt-5.4',
            tokensPrompt: plannerPrompt,
            tokensCompletion: plannerCompletion,
            tokensTotal: plannerTotal,
          })
        } catch (deductErr) {
          console.warn('[generate-tests/plan] token deduction failed (non-fatal)', deductErr)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { success: false, fallback: 'rule_based', reason: message },
        { status: 200 },
      )
    }

    const plan: GenerationPlan = {
      planVersion: CURRENT_PLAN_VERSION,
      planHash,
      frontendPlan,
      backendPlan,
      totalPlannedTests: totalPlannedTests(frontendPlan, backendPlan),
      warnings,
      generatedAt: new Date().toISOString(),
    }

    // Persist — ignore on conflict (user_id, plan_hash) unique index. Another
    // concurrent request with the same hash could have landed first; that's
    // fine, the cached row serves future calls.
    try {
      await db
        .insert(generationPlans)
        .values({
          userId,
          planHash,
          planJson: plan,
        })
        .onConflictDoNothing({
          target: [generationPlans.userId, generationPlans.planHash],
        })
    } catch (insertErr) {
      console.warn('[generate-tests/plan] cache insert failed (non-fatal)', insertErr)
    }

<<<<<<< bugfix/tokens-gating
    const responseBody = { success: true, plan, cache: 'miss' as const, plannerTokens }
=======
    // Deduct a flat token cost per planner run (one gpt-5.4-mini call per axis).
    try {
      await deductTokens({ userId, tokensUsed: PLANNER_TOKEN_COST })
    } catch (deductErr) {
      console.warn('[generate-tests/plan] token deduction failed (non-fatal)', deductErr)
    }

    const responseBody = { success: true, plan, cache: 'miss' as const }
>>>>>>> capillary/sabre

    if (idempotencyKey) {
      await storeIdempotencyResult({
        idempotencyKey,
        userId,
        endpoint: ENDPOINT,
        responseBody,
      })
    }

    return NextResponse.json(responseBody)
  } catch (error) {
    console.error('[generate-tests/plan] error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    // Any uncaught error routes to rule-based fallback with HTTP 200 so the
    // MCP can fall back cleanly instead of aborting the whole pipeline.
    return NextResponse.json(
      { success: false, fallback: 'rule_based', reason: message },
      { status: 200 },
    )
  }
}
