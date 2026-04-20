/**
 * Inngest orchestrator — fans a `generation/job.requested` event out into one
 * `generation/agent.requested` event per enabled agent, waits for every agent
 * to emit `generation/agent.completed`, then finalizes the `generation_jobs`
 * row with an aggregate status (succeeded / partial / failed) and a per-agent
 * outcome breakdown stored inside `result.agentOutcomes`.
 *
 * Event contract
 *  - Input:    `generation/job.requested` with `{ jobId }`.
 *  - Fan-out:  `generation/agent.requested` with `{ jobId, agent }` (one per agent).
 *  - Waits on: `generation/agent.completed` with `{ jobId, agent, ok, errorCode?, deduped? }`.
 *              (The sibling agent function emits `deduped: true` for a no-op replay
 *              of the same (jobId, agent) pair; we treat it as `ok: true` for
 *              aggregation since the work has already landed.)
 *  - Output:   `generation/job.completed` with `{ jobId, status, okCount, totalAgents }`
 *              for downstream SSE / webhook fan-in consumers (P2-j et al.).
 *
 * Idempotency
 *  - `step.run`/`step.sendEvent` are both memoized across the outer function's
 *    retry attempts (Inngest v4 semantics), so fan-out never double-sends on
 *    the 1 retry we allow.
 *  - `mark-running` is a status-guarded UPDATE (WHERE status='queued'); if two
 *    orchestrator runs collide for the same jobId, the second sees
 *    `already_running` and still proceeds — the fan-out events and the per-
 *    agent function are themselves idempotent (via `agents_completed`
 *    membership) so re-execution is harmless.
 *
 * Timeout behavior
 *  - Each per-agent `waitForEvent` has a 12-minute ceiling. If the per-agent
 *    worker exhausts its own retries and never emits `agent.completed`, we
 *    record an AGENT_TIMEOUT outcome for that slot and fold it into the
 *    aggregate status (partial unless every agent timed out, then failed).
 *
 * SDK notes (Inngest v4, pinned ^4.2.4)
 *  - `createFunction` takes `(options, handler)` — the `triggers` array lives
 *    inside `options`. The sibling agent file uses the same shape.
 *  - `step.waitForEvent` accepts a `timeout` option (required) plus an `if`
 *    CEL-ish expression to narrow the match — jobId+agent here.
 *  - `step.sendEvent` accepts an array payload for true batched fan-out; we
 *    use that instead of N separate calls so the fan-out is a single memoized
 *    step.
 */

import { inngest } from '@/lib/inngest/client'
import { db } from '@/lib/db'
import { generationJobs } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'

interface JobRequestedEventData {
  jobId: string
}

type AgentOutcome = {
  agent: string
  ok: boolean
  errorCode?: string
}

type FinalStatus = 'succeeded' | 'failed' | 'partial'

export const generateTestsOrchestrator = inngest.createFunction(
  {
    id: 'generate-tests-orchestrator',
    // One retry is enough: every side-effecting step is memoized, so a retry
    // only re-runs the steps that actually failed (typically a DB blip).
    retries: 1,
    concurrency: [
      // Soft ceiling on in-flight orchestrators. Each orchestrator is mostly
      // blocked on waitForEvent (cheap), but capping protects the DB from a
      // surge of fan-out writes.
      { limit: 50 },
    ],
    triggers: [{ event: 'generation/job.requested' }],
  },
  async ({ event, step, logger }) => {
    const { jobId } = event.data as JobRequestedEventData

    // 1. Load the job row once (memoized). If it's gone, abort — nothing to do.
    const job = await step.run('load-job', async () => {
      const [row] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId))
      if (!row) return null
      return {
        id: row.id,
        userId: row.userId,
        status: row.status,
        agentsRequested: (row.agentsRequested ?? []) as string[],
      }
    })
    if (!job) {
      logger.warn({ jobId }, 'job not found, orchestrator exiting')
      return { ok: false, reason: 'job_not_found' as const }
    }

    // 2. Transition queued→running with a status guard so concurrent
    //    orchestrator triggers for the same jobId can't double-transition.
    const transition = await step.run('mark-running', async () => {
      const result = await db
        .update(generationJobs)
        .set({
          status: 'running',
          startedAt: sql`COALESCE(started_at, now())`,
        })
        .where(
          and(
            eq(generationJobs.id, jobId),
            eq(generationJobs.status, 'queued')
          )
        )
        .returning({ id: generationJobs.id })
      return result.length > 0 ? 'transitioned' : 'already_running'
    })

    // 3. Empty-agents guard. The API route should never produce this but if
    //    it does, finalize immediately so the row doesn't hang in 'running'.
    const agents = job.agentsRequested.filter(Boolean)
    if (agents.length === 0) {
      await step.run('finalize-empty', async () => {
        await db
          .update(generationJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            error: { reason: 'no_agents_requested' },
          })
          .where(eq(generationJobs.id, jobId))
      })
      await step.sendEvent('job-done-empty', {
        name: 'generation/job.completed',
        data: {
          jobId,
          status: 'failed' as const,
          okCount: 0,
          totalAgents: 0,
        },
      })
      logger.warn({ jobId }, 'no agents requested — job marked failed')
      return { ok: false, reason: 'no_agents_requested' as const }
    }

    // 4. Fan-out. Inngest v4 supports an array payload on a single sendEvent
    //    call — memoized once regardless of agent count.
    await step.sendEvent(
      'fan-out-agents',
      agents.map((agent) => ({
        name: 'generation/agent.requested',
        data: { jobId, agent },
      }))
    )

    // 5. Wait for each agent in parallel. `waitForEvent` returns `null` on
    //    timeout; we fold that into an AGENT_TIMEOUT outcome below. The `if`
    //    expression is CEL-ish — jobId is a DB-generated uuid and agent is
    //    from our own enum, so the single-quoted interpolation is safe.
    const completions = await Promise.all(
      agents.map((agent) =>
        step.waitForEvent(`wait-${agent}`, {
          event: 'generation/agent.completed',
          timeout: '12m',
          if: `event.data.jobId == '${jobId}' && event.data.agent == '${agent}'`,
        })
      )
    )

    // 6. Aggregate. A `deduped: true` completion is treated as a success
    //    (the work already landed for that agent on a prior orchestrator
    //    run). A null result means waitForEvent timed out.
    const agentOutcomes: AgentOutcome[] = agents.map((agent, i) => {
      const ev = completions[i]
      if (!ev) return { agent, ok: false, errorCode: 'AGENT_TIMEOUT' }
      const data = (ev.data ?? {}) as {
        ok?: boolean
        errorCode?: string
        deduped?: boolean
      }
      return {
        agent,
        ok: Boolean(data.ok),
        ...(data.errorCode ? { errorCode: data.errorCode } : {}),
      }
    })
    const okCount = agentOutcomes.filter((a) => a.ok).length
    const finalStatus: FinalStatus =
      okCount === agents.length
        ? 'succeeded'
        : okCount === 0
          ? 'failed'
          : 'partial'

    // 7. Persist the aggregate. `jsonb_set` merges agentOutcomes into any
    //    result.tests / result.errors the per-agent workers already wrote.
    await step.run('finalize', async () => {
      const outcomesJson = JSON.stringify(agentOutcomes)
      await db
        .update(generationJobs)
        .set({
          status: finalStatus,
          completedAt: new Date(),
          result: sql`jsonb_set(COALESCE(${generationJobs.result}, '{}'::jsonb), '{agentOutcomes}', ${outcomesJson}::jsonb)`,
        })
        .where(eq(generationJobs.id, jobId))
    })

    // 8. Terminal signal for future SSE / webhook consumers.
    await step.sendEvent('job-done', {
      name: 'generation/job.completed',
      data: {
        jobId,
        status: finalStatus,
        okCount,
        totalAgents: agents.length,
      },
    })

    logger.info(
      {
        jobId,
        finalStatus,
        okCount,
        totalAgents: agents.length,
        transition,
      },
      'orchestrator finalized'
    )
    return {
      ok: true as const,
      finalStatus,
      okCount,
      totalAgents: agents.length,
    }
  }
)
