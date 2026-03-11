import { NextRequest } from 'next/server'
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { mcpTelemetryEvents } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

const TERMINAL_PHASES = new Set(['completed', 'error', 'error_reported'])

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

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController | null = null
  let closed = false

  const send = (data: unknown) => {
    if (closed || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
    } catch {
      closed = true
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      controllerRef = controller

      send({ type: 'connected', runId })

      let lastEventTime = new Date(Date.now() - 72 * 60 * 60 * 1000)
      const seenIds = new Set<string>()
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
                gt(mcpTelemetryEvents.occurredAt, lastEventTime)
              )
            )
            .orderBy(mcpTelemetryEvents.occurredAt)
            .limit(500)

          let maxSeen = lastEventTime
          for (const row of rows) {
            if (seenIds.has(row.id)) continue
            seenIds.add(row.id)
            send({
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
          }

          if (terminated) {
            send({ type: 'done' })
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
