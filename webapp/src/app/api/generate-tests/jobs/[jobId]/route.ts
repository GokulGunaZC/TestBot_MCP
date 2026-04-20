import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, generationJobs } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * Read-only polling endpoint for the MCP client. Harvests status + partial
 * test results from the `generation_jobs` table. Companion to P2-f.
 *
 * Auth mirrors /api/generate-tests: `x-api-key` header → db lookup via keyHash,
 * same active/revoked/expired checks. Rate limit reuses `checkRateLimit` with
 * a 10 req/s budget so pollers can sustain ~5/s per key without friction.
 *
 * Response shape is a stable projection of the job row — `payload` is
 * intentionally excluded so a stolen api-key scoped to this route can't
 * exfiltrate the original PRD text.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ENDPOINT = '/api/generate-tests/jobs/[jobId]'
const UUID_RE = /^[0-9a-f-]{36}$/i

type AgentErrorEntry = {
  agent?: unknown
  errorCode?: unknown
  code?: unknown
}

function isAgentErrorList(value: unknown): value is AgentErrorEntry[] {
  return Array.isArray(value)
}

function errorCodeForAgent(agent: string, pools: unknown[]): string | null {
  for (const pool of pools) {
    if (!isAgentErrorList(pool)) continue
    for (const entry of pool) {
      if (entry && typeof entry === 'object' && (entry as AgentErrorEntry).agent === agent) {
        const code =
          (entry as AgentErrorEntry).errorCode ?? (entry as AgentErrorEntry).code ?? null
        return typeof code === 'string' ? code : null
      }
    }
  }
  return null
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  const maybe = value as unknown as { toISOString?: () => string }
  if (typeof maybe.toISOString === 'function') {
    try {
      return maybe.toISOString()
    } catch {
      return String(value)
    }
  }
  return typeof value === 'string' ? value : String(value)
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params

  // 1. UUID shape validation. Cheap + prevents wasted db round-trips on
  //    garbage input. We stay lax on the hex character class (hyphen allowed
  //    anywhere) because Postgres itself will reject malformed UUIDs — this
  //    is a form gate, not a parser.
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: 'INVALID_JOB_ID' }, { status: 400 })
  }

  // 2. Auth — x-api-key only. No body.api_key fallback here: this is a GET,
  //    and the MCP always sends the header.
  const rawKey = request.headers.get('x-api-key')
  if (!rawKey) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const keyHash = hashApiKey(rawKey)
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

  if (!apiKeyRecord || apiKeyRecord.revoked) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  // 3. Rate limit — reuse the per-key limiter from the main endpoint.
  //    10 rps / 600 rpm is comfortably above the MCP's ~1 rps steady-state
  //    polling loop so we don't starve legit clients.
  const rateResult = await checkRateLimit({
    keyHash,
    userId: apiKeyRecord.userId,
    endpoint: ENDPOINT,
    limitPerSecond: 10,
    limitPerMinute: 600,
  })
  if (!rateResult.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMIT_EXCEEDED' },
      { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
    )
  }

  // 4. DB lookup — single row by primary key.
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1)

  // 5. Not found vs forbidden. Order matters: we 404 before 403 so an
  //    attacker who guesses a random UUID without a matching row can't
  //    probe for existence. Once the row exists, we do reveal "this is not
  //    yours" via 403 — acceptable per spec because they already had to
  //    authenticate + supply a valid UUID to get here.
  if (!job) {
    return NextResponse.json({ error: 'JOB_NOT_FOUND' }, { status: 404 })
  }

  if (job.userId !== apiKeyRecord.userId) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  // 6. Build projection. Defensive `?? []` / `?? null` so a null `result`
  //    (queued / early running state) doesn't crash on `.tests` / `.errors`.
  const result = (job.result ?? null) as
    | {
        tests?: unknown[]
        generationMeta?: unknown
        errors?: AgentErrorEntry[]
      }
    | null
  const error = (job.error ?? null) as { agents?: AgentErrorEntry[] } | AgentErrorEntry[] | null

  const agentsRequested = job.agentsRequested ?? []
  const agentsCompletedRaw = job.agentsCompleted ?? []

  // Combine every place agent-level errors could live into one lookup pool.
  const errorPools: unknown[] = []
  if (result?.errors) errorPools.push(result.errors)
  if (Array.isArray(error)) {
    errorPools.push(error)
  } else if (error && typeof error === 'object' && 'agents' in error && error.agents) {
    errorPools.push((error as { agents?: AgentErrorEntry[] }).agents ?? [])
  }

  const agentsCompleted = agentsCompletedRaw.map((agent) => {
    const code = errorCodeForAgent(agent, errorPools)
    if (code) return { agent, ok: false, errorCode: code }
    return { agent, ok: true }
  })

  const tests = Array.isArray(result?.tests) ? result!.tests : []
  const generationMeta = result?.generationMeta ?? null
  const errors = Array.isArray(result?.errors) ? result!.errors : []

  const createdAt = toIso(job.createdAt)
  const startedAt = toIso(job.startedAt)
  const completedAt = toIso(job.completedAt)

  // 7. Compute ETag. Short concatenation — raw tag is fine, no hashing
  //    needed. The shape is stable across restarts because every field is
  //    pulled directly from the row.
  const etag = `W/"${job.status}-${agentsCompletedRaw.length}-${tests.length}-${completedAt ?? ''}"`

  // 8. Conditional GET — if caller already has this exact snapshot, short-
  //    circuit with 304 and no body. This is what makes 1 rps polling cheap.
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'private, no-store',
      },
    })
  }

  const body = {
    jobId: job.id,
    status: job.status,
    agentsRequested,
    agentsCompleted,
    tests,
    generationMeta,
    errors,
    createdAt,
    startedAt,
    completedAt,
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      ETag: etag,
    },
  })
}
