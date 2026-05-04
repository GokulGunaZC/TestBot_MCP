import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, generationJobs, profiles } from '@/lib/db/schema'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { dispatchAgents, planAgents } from '@/lib/test-generation/agent-dispatcher'
import { inngest } from '@/lib/inngest/client'
import type {
  CapturedContext,
  GenerationOptions,
  ProjectInfo,
  ParsedPRD,
  ExplorationArtifact,
  Role,
  AgentRunRecord,
  AgentName,
} from '@/lib/test-generation/types'
import { CURRENT_PLAN_VERSION } from '@/lib/test-generation/plan-schema'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkTokenBalance, deductTokens } from '@/lib/tokens'
import { checkConcurrencyLimit } from '@/lib/concurrency-limit'
import { checkIdempotency, storeIdempotencyResult } from '@/lib/idempotency'
import { validateGenerateTests } from '@/lib/validation'
import { checkAiGuard, recordAiCall } from '@/lib/ai-guard'
import { runAbuseDetection } from '@/lib/abuse-detector'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/generate-tests'

// Matches vercel.json maxDuration for this route. Previously set to 60 (Hobby
// ceiling) but that silently killed agents before gpt-5.4-mini could respond.
// Set to 800 to match vercel.json; local Next.js ignores this entirely.
export const maxDuration = 800

const KNOWN_AGENTS: readonly AgentName[] = ['smoke', 'frontend', 'api', 'workflow', 'error', 'expansion']

// Normalise an incoming agents[] list: lowercase, trim, dedupe. Returns either
// a validated Set<AgentName> or a ValidationIssue the caller turns into 400.
function normalizeAgents(raw: unknown):
  | { ok: true; set: Set<AgentName> | null }
  | { ok: false; code: 'INVALID_AGENTS' | 'EMPTY_AGENTS'; unknown?: string[] } {
  if (raw === undefined || raw === null || raw === false) return { ok: true, set: null }
  if (!Array.isArray(raw)) return { ok: false, code: 'INVALID_AGENTS' }

  const cleaned = raw
    .filter((v) => typeof v === 'string')
    .map((v) => (v as string).trim().toLowerCase())
    .filter((v) => v.length > 0)

  if (cleaned.length === 0) return { ok: false, code: 'EMPTY_AGENTS' }

  const unknown = cleaned.filter((a) => !KNOWN_AGENTS.includes(a as AgentName))
  if (unknown.length > 0) return { ok: false, code: 'INVALID_AGENTS', unknown }

  return { ok: true, set: new Set(cleaned as AgentName[]) }
}

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

    // 6a. Validate optional agents[] body field. When present, only the named
    // agents run — this is how the MCP chunks generation across multiple <60s
    // Vercel invocations. Omitted / null / false → run all agents (back-compat).
    const agentsResult = normalizeAgents((body as { agents?: unknown }).agents)
    if (agentsResult.ok === false) {
      const errPayload: Record<string, unknown> = {
        error: agentsResult.code,
        allowed: KNOWN_AGENTS,
      }
      if (agentsResult.code === 'INVALID_AGENTS' && agentsResult.unknown) {
        errPayload.unknown = agentsResult.unknown
      }
      return NextResponse.json(errPayload, { status: 400 })
    }
    const agentsAllowlist = agentsResult.set

    // 6b. Optional per-agent plan slice. When the MCP ran the P1.5 planner
    // pre-pass, it projects a slice per agent and passes it through here so
    // the agent-level prompt can scope itself to "only these targets". A
    // planVersion mismatch means the caller is on an old client / schema
    // drift; we reject eagerly rather than silently ignore the slice.
    const planBody = (body as { plan?: { slice?: unknown; planVersion?: unknown } }).plan
    let agentPlanSlice: Record<string, unknown> | undefined
    if (planBody) {
      if (planBody.planVersion !== CURRENT_PLAN_VERSION) {
        return NextResponse.json(
          { error: 'INCOMPATIBLE_PLAN_VERSION', expected: CURRENT_PLAN_VERSION, got: planBody.planVersion ?? null },
          { status: 400 },
        )
      }
      if (planBody.slice && typeof planBody.slice === 'object' && !Array.isArray(planBody.slice)) {
        agentPlanSlice = planBody.slice as Record<string, unknown>
      }
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

    // ── Dual-mode decision: sync (Phase 1) vs async Inngest enqueue (Phase 2) ──
    //
    // Async path is opt-in per-request via `x-healix-async: 1` header (or
    // `body.async: true`) AND gated by either the global env flag
    // `HEALIX_GEN_ASYNC=true` or the per-user early-access override
    // `profile.settings.gen_async_enabled=true`. Legacy MCP clients that
    // never send the header stay on the sync path even when the env flag
    // is on — a zero-risk rollout.
    //
    // Manual smoke test for this block:
    //   curl -X POST http://localhost:3000/api/generate-tests \
    //     -H "x-api-key: $HEALIX_KEY" \
    //     -H "x-healix-async: 1" \
    //     -H "content-type: application/json" \
    //     -d '{"context":{},"testType":"backend","projectInfo":{"apiOnly":true}}'
    //   # expect: { jobId, status:"queued", agentsRequested, pollUrl } with HTTP 202
    const asyncHeader = request.headers.get('x-healix-async')
    const asyncBodyFlag = (body as { async?: unknown })?.async === true
    // Best-effort user-level override lookup. The `profiles` table doesn't
    // currently carry a `settings` jsonb, so this cast stays a no-op until
    // that column ships — at which point the override lights up automatically
    // without further code change. Failures are swallowed: if we can't read
    // the row we just fall back to env-only gating.
    let userOverrideEnabled = false
    try {
      const [profile] = await db
        .select()
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)
      userOverrideEnabled = Boolean(
        (profile as unknown as { settings?: { gen_async_enabled?: unknown } })?.settings?.gen_async_enabled
      )
    } catch {
      // swallow: env flag remains the only gate
    }
    const flagEnabled = process.env.HEALIX_GEN_ASYNC === 'true' || userOverrideEnabled
    const wantAsync = (asyncHeader === '1' || asyncBodyFlag) && flagEnabled

    let fallbackToSync = false

    if (wantAsync) {
      // 1. Per-user concurrent-job cap. `count(*)` here is cheap because
      //    the partial index `generation_jobs_status_idx` covers
      //    WHERE status IN ('queued','running') — Postgres plans this as
      //    an index-only scan on a tiny row subset. We also report the
      //    true in-flight count in the error message via future edits.
      const MAX_CONCURRENT_JOBS = 3
      const inFlight = await db
        .select({ count: sql<number>`count(*)` })
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.userId, userId),
            inArray(generationJobs.status, ['queued', 'running'])
          )
        )
      const currentInFlight = Number(inFlight[0]?.count ?? 0)
      if (currentInFlight >= MAX_CONCURRENT_JOBS) {
        return NextResponse.json(
          {
            error: 'TOO_MANY_CONCURRENT_JOBS',
            message: `You have ${MAX_CONCURRENT_JOBS} generation jobs in flight. Wait for one to complete.`,
          },
          { status: 429 }
        )
      }

      // 2. Determine the agent list. Either the caller pinned the set
      //    explicitly via `body.agents[]` (already validated above into
      //    `agentsAllowlist`), or we run the same rule-based planner the
      //    sync path uses so the Inngest orchestrator fans out the same
      //    shape the sync path would have produced.
      let agentsRequested: AgentName[]
      if (agentsAllowlist && agentsAllowlist.size > 0) {
        agentsRequested = Array.from(agentsAllowlist)
      } else {
        const plan = planAgents({
          testType: (body.testType || 'both') as 'frontend' | 'backend' | 'both',
          projectInfo: (body.projectInfo || {}) as ProjectInfo,
          context: (body.context || {}) as CapturedContext,
          parsedPRD: (body.parsedPRD || null) as ParsedPRD | null,
          explorationArtifact: (body.explorationArtifact || null) as ExplorationArtifact | null,
          options: (body.options || {}) as GenerationOptions,
        })
        agentsRequested = plan.agents
      }

      // 3. Per-user idempotency: if a prior job exists for the same
      //    (userId, idempotencyKey), replay the 202 shape. Honors both the
      //    header and the body field — same contract as the sync path.
      const asyncIdemKey =
        request.headers.get('x-idempotency-key') ||
        (typeof (body as { idempotencyKey?: unknown })?.idempotencyKey === 'string'
          ? ((body as { idempotencyKey?: string }).idempotencyKey as string)
          : null)
      if (asyncIdemKey) {
        const [existing] = await db
          .select()
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.userId, userId),
              eq(generationJobs.idempotencyKey, asyncIdemKey)
            )
          )
          .limit(1)
        if (existing) {
          return NextResponse.json(
            {
              jobId: existing.id,
              status: existing.status,
              agentsRequested: existing.agentsRequested ?? [],
              pollUrl: `/api/generate-tests/jobs/${existing.id}`,
            },
            { status: 202 }
          )
        }
      }

      // 4. Insert the job row with the frozen payload. The Inngest worker
      //    re-hydrates the request from this row, so we store the *raw*
      //    validated body (including `plan.slice` etc.) rather than the
      //    post-unpack variables.
      const [inserted] = await db
        .insert(generationJobs)
        .values({
          userId,
          apiKeyId: apiKeyRecord.id,
          status: 'queued',
          payload: body as Record<string, unknown>,
          agentsRequested: agentsRequested as string[],
          idempotencyKey: asyncIdemKey,
        })
        .returning({ id: generationJobs.id })

      const jobId = inserted.id

      // 5. Send the Inngest event. On failure we mark the orphaned row as
      //    failed (best-effort) and FALL THROUGH to the sync path so the
      //    caller gets a real 200 response rather than a 500 — an
      //    Inngest outage must never turn into a user-visible outage.
      try {
        await inngest.send({ name: 'generation/job.requested', data: { jobId } })
      } catch (inngestErr) {
        const msg = inngestErr instanceof Error ? inngestErr.message : String(inngestErr)
        console.warn('[generate-tests] inngest.send failed, falling back to sync', {
          jobId,
          err: msg,
        })
        await db
          .update(generationJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            error: { reason: 'inngest_send_failed', message: msg },
          })
          .where(eq(generationJobs.id, jobId))
          .catch(() => {
            /* swallow; best-effort cleanup */
          })
        fallbackToSync = true
      }

      if (!fallbackToSync) {
        const responsePayload = {
          jobId,
          status: 'queued' as const,
          agentsRequested,
          pollUrl: `/api/generate-tests/jobs/${jobId}`,
        }
        if (asyncIdemKey) {
          await storeIdempotencyResult({
            idempotencyKey: asyncIdemKey,
            userId,
            endpoint: ENDPOINT,
            responseBody: responsePayload,
          })
        }
        console.log('[generate-tests] async-enqueue', {
          userId,
          jobId,
          agents: agentsRequested,
        })
        return NextResponse.json(responsePayload, { status: 202 })
      }
      // fall through to the sync path below
    }

    // Business logic
    const { context, testType, prd, parsedPRD, explorationArtifact, roles, projectInfo, options } = body

    const ctx = (context || {}) as CapturedContext
    const info = (projectInfo || {}) as ProjectInfo
    const type = (testType || 'both') as 'frontend' | 'backend' | 'both'
    const prdContent = (prd || '') as string
    const genOptions = (options || {}) as GenerationOptions
    const parsedPRDInput = (parsedPRD || null) as ParsedPRD | null
    const explorationInput = (explorationArtifact || null) as ExplorationArtifact | null
    const rolesInput = Array.isArray(roles) ? (roles as Role[]) : []

    // Per-agent telemetry. Each generator agent (smoke/frontend/api/workflow/
    // error/expansion) emits one `recordAiCall` row tagged with the agent name,
    // latency, and its own token usage — the rows drive the per-agent dashboard
    // (SELECT agent, AVG(latency_ms), SUM(tokens_total) FROM ... GROUP BY agent).
    const agentTelemetry: AgentRunRecord[] = []
    const runId = request.headers.get('x-healix-run-id') || null
    const { files: generatedFiles, summary, plan } = await dispatchAgents({
      context: ctx,
      prd: prdContent,
      parsedPRD: parsedPRDInput,
      explorationArtifact: explorationInput,
      roles: rolesInput,
      testType: type,
      projectInfo: info,
      options: genOptions,
      agentsAllowlist: agentsAllowlist ?? undefined,
      agentPlanSlice,
      generatorConfig: {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        fallbackOnFailure: genOptions.strictAIGeneration !== true,
        enforceValidation: true,
        syntaxValidationMode: 'fail-open',
        strictAIGeneration: genOptions.strictAIGeneration === true,
        // Localhost-first: generation legitimately runs for minutes under
        // gpt-5.4-mini high-reasoning, especially for the frontend and error
        // agents. HEALIX_OPENAI_TIMEOUT_MS lets operators tighten this
        // when running behind a reverse proxy with its own budget.
        timeout: Number(process.env.HEALIX_OPENAI_TIMEOUT_MS) || 540_000,
      },
      onAgentComplete: async (record) => {
        agentTelemetry.push(record)
        await recordAiCall({
          userId,
          apiKeyId: apiKeyRecord.id,
          endpoint: ENDPOINT,
          agent: record.agent,
          latencyMs: record.latencyMs,
          modelUsed: record.modelUsed ?? undefined,
          tokensPrompt: record.tokensPrompt,
          tokensCompletion: record.tokensCompletion,
          tokensTotal: record.tokensTotal,
          success: record.success,
          errorCode: record.errorCode ?? null,
          runId,
        })
      },
    })

    const tokensConsumed = summary.tokenUsage.totalTokens
    if (tokensConsumed > 0) {
      await deductTokens({ userId, tokensUsed: tokensConsumed })
    }

    const responseBody = {
      success: true,
      tests: generatedFiles,
      count: generatedFiles.length,
      generationMeta: summary.generationMeta,
      byType: summary.byType,
      agentPlan: plan,
      agentRuns: agentTelemetry,
    }

    // 9. Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult({ idempotencyKey, userId, endpoint: ENDPOINT, responseBody })
    }

    // 10. Async abuse detection (non-blocking)
    runAbuseDetection({ userId, apiKeyId: apiKeyRecord.id }).catch((err: unknown) => {
      console.error('[generate-tests] abuse detection failed', err)
    })

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
