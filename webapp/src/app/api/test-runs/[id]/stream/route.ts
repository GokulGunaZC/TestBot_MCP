import { NextRequest } from 'next/server'
import { and, desc, eq, gt, gte, isNotNull, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { generationJobs, mcpTelemetryEvents, testRuns } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported'])

// ── Generation-job progress (P2-i) ───────────────────────────────────────────
// Mirrors the projection built in /api/test-runs/[id]/route.ts and
// /api/generate-tests/jobs/[jobId]/route.ts. Emitted as `{ type: 'generation_job', job }`
// on initial connection and re-emitted on each poll when the snapshot changes,
// so the dashboard's live progress chip updates without waiting for the next
// /api/test-runs/[id] refetch.
type AgentErrorEntry = { agent?: unknown; errorCode?: unknown; code?: unknown }

function isAgentErrorList(value: unknown): value is AgentErrorEntry[] {
  return Array.isArray(value)
}

function errorCodeForAgent(agent: string, pools: unknown[]): string | null {
  for (const pool of pools) {
    if (!isAgentErrorList(pool)) continue
    for (const entry of pool) {
      if (entry && typeof entry === 'object' && (entry as AgentErrorEntry).agent === agent) {
        const code = (entry as AgentErrorEntry).errorCode ?? (entry as AgentErrorEntry).code ?? null
        return typeof code === 'string' ? code : null
      }
    }
  }
  return null
}

type GenerationJobProjection = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  agentsRequested: string[]
  agentsCompleted: Array<{ agent: string; ok: boolean; errorCode?: string }>
  completedAt: string | null
}

/**
 * Look up the ingested test_runs row for a given MCP-side runId (metadata.runId),
 * then fetch its latest linked generation_jobs row. Returns null when either
 * doesn't exist yet (sync-mode legacy runs never write a generation_jobs row).
 * Two sequential queries, not a join — matches the pattern already used by
 * /api/test-runs/[id]/route.ts for looking up the ingested row.
 */
async function loadGenerationJobForLiveRun(
  runId: string,
  userId: string
): Promise<GenerationJobProjection | null> {
  const [ingestedRow] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.userId, userId),
        sql`${testRuns.reportJson}->'metadata'->>'runId' = ${runId}`
      )
    )
    .orderBy(testRuns.createdAt)
    .limit(1)
  if (!ingestedRow) return null

  // Migration 0007_generation_jobs may land after webapp deploy; degrade to
  // "no linked job" on DB errors so the stream keeps working.
  let job: typeof generationJobs.$inferSelect | undefined
  try {
    const rows = await db
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.testRunId, ingestedRow.id), eq(generationJobs.userId, userId)))
      .orderBy(desc(generationJobs.createdAt))
      .limit(1)
    job = rows[0]
  } catch {
    return null
  }
  if (!job) return null

  const result = (job.result ?? null) as { errors?: AgentErrorEntry[] } | null
  const error = (job.error ?? null) as { agents?: AgentErrorEntry[] } | AgentErrorEntry[] | null
  const errorPools: unknown[] = []
  if (result?.errors) errorPools.push(result.errors)
  if (Array.isArray(error)) errorPools.push(error)
  else if (error && typeof error === 'object' && 'agents' in error && error.agents) {
    errorPools.push((error as { agents?: AgentErrorEntry[] }).agents ?? [])
  }

  const agentsRequested = job.agentsRequested ?? []
  const agentsCompleted = (job.agentsCompleted ?? []).map((agent) => {
    const code = errorCodeForAgent(agent, errorPools)
    return code ? { agent, ok: false, errorCode: code } : { agent, ok: true }
  })

  return {
    jobId: job.id,
    status: job.status as GenerationJobProjection['status'],
    agentsRequested,
    agentsCompleted,
    completedAt: job.completedAt?.toISOString() ?? null,
  }
}

function generationJobSignature(job: GenerationJobProjection | null): string {
  if (!job) return 'none'
  // Cheap identity — status + counts + completedAt is enough to detect any
  // change we'd want to push. agentsCompleted length shifts every time a new
  // agent resolves; errorCodes are reflected via the ok: false flips.
  const failed = job.agentsCompleted.filter((a) => !a.ok).length
  return `${job.jobId}:${job.status}:${job.agentsCompleted.length}:${failed}:${job.completedAt ?? ''}`
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  if (!id.startsWith('live-')) {
    return new Response('Not a live run', { status: 400 })
  }

  const runId = id.slice('live-'.length).trim()
  if (!runId) {
    return new Response('Invalid run id', { status: 400 })
  }

  // SSE reconnection: browser sends Last-Event-ID with the last event's DB uuid.
  // Look up its occurredAt so we resume from the right cursor instead of 72h ago.
  const lastEventIdHeader = request.headers.get('last-event-id')
  let resumeAfter: Date | null = null
  if (lastEventIdHeader) {
    try {
      const [cursor] = await db
        .select({ occurredAt: mcpTelemetryEvents.occurredAt })
        .from(mcpTelemetryEvents)
        .where(eq(mcpTelemetryEvents.id, lastEventIdHeader))
        .limit(1)
      if (cursor?.occurredAt) {
        resumeAfter = cursor.occurredAt
      }
    } catch {
      // Non-fatal: fall back to full history scan
    }
  }

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController | null = null
  let closed = false

  const sendRaw = (chunk: string) => {
    if (closed || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(chunk))
    } catch {
      closed = true
    }
  }

  const sendData = (eventId: string | null, data: unknown) => {
    let chunk = ''
    if (eventId) chunk += `id: ${eventId}\n`
    chunk += `data: ${JSON.stringify(data)}\n\n`
    sendRaw(chunk)
  }

  const stream = new ReadableStream({
    async start(controller) {
      controllerRef = controller

      // Pull the initial generation-job snapshot in parallel with the rest of
      // the connection setup. A miss (null) is the common case for runs
      // without an async job, so swallow errors — the chip just stays hidden.
      let lastGenerationJobSig = 'none'
      try {
        const initialJob = await loadGenerationJobForLiveRun(runId, user.id)
        lastGenerationJobSig = generationJobSignature(initialJob)
        sendData(null, { type: 'connected', runId, generationJob: initialJob })
      } catch {
        sendData(null, { type: 'connected', runId, generationJob: null })
      }

      // If resuming, start 1 s before the cursor to catch same-ms batches;
      // seenIds (pre-seeded with the cursor id) prevents re-sending it.
      let lastEventTime = resumeAfter
        ? new Date(resumeAfter.getTime() - 1000)
        : new Date(Date.now() - 72 * 60 * 60 * 1000)

      const seenIds = new Set<string>()
      if (lastEventIdHeader) seenIds.add(lastEventIdHeader)
      let terminated = false

      const poll = async () => {
        if (closed || terminated) return
        try {
          const rows = await db
            .select({
              id: mcpTelemetryEvents.id,
              phase: mcpTelemetryEvents.phase,
              status: mcpTelemetryEvents.status,
              message: mcpTelemetryEvents.message,
              errorCode: mcpTelemetryEvents.errorCode,
              reason: mcpTelemetryEvents.reason,
              metadata: mcpTelemetryEvents.metadata,
              eventType: mcpTelemetryEvents.eventType,
              occurredAt: mcpTelemetryEvents.occurredAt,
              durationMs: mcpTelemetryEvents.durationMs,
            })
            .from(mcpTelemetryEvents)
            .where(
              and(
                eq(mcpTelemetryEvents.userId, user.id),
                eq(mcpTelemetryEvents.runId, runId),
                isNotNull(mcpTelemetryEvents.occurredAt),
                resumeAfter
                  ? gte(mcpTelemetryEvents.occurredAt, lastEventTime)
                  : gt(mcpTelemetryEvents.occurredAt, lastEventTime)
              )
            )
            .orderBy(mcpTelemetryEvents.occurredAt)
            .limit(500)

          let maxSeen = lastEventTime
          for (const row of rows) {
            if (seenIds.has(row.id)) continue
            seenIds.add(row.id)
            sendData(row.id, {
              type: 'event',
              id: row.id,
              phase: row.phase,
              status: row.status,
              message: row.message,
              errorCode: row.errorCode,
              reason: row.reason,
              metadata: row.metadata,
              eventType: row.eventType,
              occurredAt: row.occurredAt?.toISOString() ?? null,
              durationMs: row.durationMs,
            })
            if (row.occurredAt && row.occurredAt > maxSeen) {
              maxSeen = row.occurredAt
            }
            if (row.phase && TERMINAL_PHASES.has(row.phase.toLowerCase())) {
              terminated = true
            }
          }

          // Roll back 1 s from the max seen so rapid-fire same-millisecond
          // batches are always re-checked; seenIds prevents duplicate sends.
          if (maxSeen > lastEventTime) {
            lastEventTime = new Date(maxSeen.getTime() - 1000)
            resumeAfter = null // cursor used; switch back to gt queries
          }

          // Check for generation-job progress drift. Cheap: 1 indexed lookup
          // on test_runs + 1 on generation_jobs, and we only broadcast when
          // the signature changes. Dashboard uses this to live-update the
          // "X/N agents complete" chip without refetching /api/test-runs/[id].
          try {
            const nextJob = await loadGenerationJobForLiveRun(runId, user.id)
            const nextSig = generationJobSignature(nextJob)
            if (nextSig !== lastGenerationJobSig) {
              lastGenerationJobSig = nextSig
              sendData(null, { type: 'generation_job', generationJob: nextJob })
            }
          } catch {
            // non-fatal — next poll will retry
          }

          if (terminated) {
            sendData(null, { type: 'done' })
            try { controller.close() } catch {}
            closed = true
            return
          }
        } catch {
          // keep retrying on db errors
        }

        if (!closed) {
          setTimeout(poll, 1500)
        }
      }

      await poll()

      request.signal.addEventListener('abort', () => {
        closed = true
        try { controller.close() } catch {}
      })
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
