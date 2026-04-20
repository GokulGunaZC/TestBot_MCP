/**
 * Inngest background function — runs exactly ONE test-generation agent per
 * event. Lifts the per-agent OpenAI call off the Vercel request path so it is
 * no longer bounded by the 60s function cap; Inngest handles retries,
 * memoization, and concurrency shaping.
 *
 * Event contract
 *  - Input:  `generation/agent.requested` with `{ jobId, agent }`.
 *  - Output: `generation/agent.completed` with `{ jobId, agent, ok, errorCode? }`.
 *
 * The event intentionally carries only `{ jobId, agent }` so the payload
 * never approaches Inngest's 1MB event ceiling. The frozen request body lives
 * on `generation_jobs.payload` (jsonb) and is fetched here by jobId.
 *
 * Concurrency
 *  - 20 concurrent runs globally (shared OpenAI budget ceiling).
 *  - 5 concurrent runs per jobId (so a single user's 5-agent fan-out can
 *    execute in parallel but a noisy job cannot starve others). Postgres
 *    row-level locking on `generation_jobs.id` serializes the UPDATE step
 *    inside each job even when multiple agents finish simultaneously.
 *
 * Idempotency
 *  - agents_completed membership check in `load-job` early-returns if the
 *    same (jobId, agent) tuple is delivered twice.
 *  - `step.run('agent-<name>', ...)` memoizes the OpenAI call across the
 *    outer function's retry attempts so we never pay for the same tokens
 *    twice on a DB-failure retry.
 *
 * Failure semantics
 *  - OpenAI / agent errors are CAUGHT and persisted into `result.errors[]`.
 *    The agent is still marked completed so the orchestrator (#41) sees
 *    forward progress.
 *  - DB errors propagate and trigger Inngest's retry (2 attempts).
 */

import { inngest } from '@/lib/inngest/client'
import { db } from '@/lib/db'
import { generationJobs } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { dispatchAgents } from '@/lib/test-generation/agent-dispatcher'
import type { AgentName, GenerateTestsParams } from '@/lib/test-generation/types'

interface AgentRequestedEventData {
  jobId: string
  agent: AgentName
}

export const generateTestsAgent = inngest.createFunction(
  {
    id: 'generate-tests-agent',
    retries: 2,
    concurrency: [
      // Global cap — protects the shared OpenAI rate-limit bucket.
      { limit: 20 },
      // Per-job cap — keeps a single noisy job from consuming the whole
      // global budget; 5 matches the 5-agent max fan-out from the planner.
      { limit: 5, key: 'event.data.jobId' },
    ],
    triggers: [{ event: 'generation/agent.requested' }],
  },
  async ({ event, step, logger }) => {
    const { jobId, agent } = event.data as AgentRequestedEventData

    // 1. Load the job row once. Memoized so retries skip the DB round-trip.
    const job = await step.run('load-job', async () => {
      const [row] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId))
      if (!row) throw new Error(`generation job ${jobId} not found`)
      return row
    })

    // 2. Duplicate-event idempotency guard.
    const alreadyCompleted = (job.agentsCompleted ?? []).includes(agent)
    if (alreadyCompleted) {
      logger.info(
        { jobId, agent },
        'agent already completed for this job — no-op'
      )
      await step.sendEvent('agent-done-noop', {
        name: 'generation/agent.completed',
        data: { jobId, agent, ok: true, deduped: true },
      })
      return { jobId, agent, ok: true, deduped: true }
    }

    // 3. Invoke the shared dispatcher with a single-agent allowlist.
    //    Errors are trapped and reported as structured failures — agent
    //    failure must NOT fail the Inngest function, only DB errors should.
    //
    //    NOTE on timeout: Inngest v4 `step.run` does not accept a `timeout`
    //    option on StepOptions (only `waitForEvent` / sleep do). The default
    //    step execution window is long enough for OpenAI calls; if we hit it
    //    we'll rely on the underlying OpenAI client's own timeout + Inngest
    //    retries rather than a per-step timeout field that would fail
    //    typecheck.
    const runResult = await step.run(`agent-${agent}`, async () => {
      const t0 = Date.now()
      try {
        const payload = job.payload as GenerateTestsParams
        const dispatchResult = await dispatchAgents({
          ...payload,
          agentsAllowlist: new Set<AgentName>([agent]),
          // Inngest has no Vercel 60s cap — let OpenAI run its natural
          // latency. Without this, the dispatcher inherits the sync-path
          // 55s cap (or worse, the old 90s hardcode) and Phase 2 is moot.
          generatorConfig: {
            apiKey: process.env.OPENAI_API_KEY,
            timeout: 540_000,
          },
        })
        return {
          ok: true as const,
          files: dispatchResult.files ?? [],
          generationMeta: dispatchResult.summary?.generationMeta ?? null,
          durationMs: Date.now() - t0,
        }
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string }
        return {
          ok: false as const,
          errorCode: e?.code || 'AGENT_FAILED',
          message: e?.message ?? String(err),
          durationMs: Date.now() - t0,
        }
      }
    })

    // 4. Persist the agent's slice of the result atomically. Single UPDATE
    //    takes a row-level write lock — two concurrent agents for the same
    //    jobId serialize safely via Postgres. We append to `result.tests[]`
    //    on success or `result.errors[]` on failure, and always array_append
    //    the agent name into `agents_completed`. `started_at` is stamped on
    //    the first agent to land for idempotency.
    await step.run('persist-agent-result', async () => {
      if (runResult.ok) {
        const filesJson = JSON.stringify(runResult.files)
        await db.execute(sql`
          UPDATE generation_jobs
          SET
            result = jsonb_set(
              COALESCE(result, '{}'::jsonb),
              '{tests}',
              COALESCE(result->'tests', '[]'::jsonb) || ${filesJson}::jsonb
            ),
            agents_completed = CASE
              WHEN ${agent} = ANY(agents_completed) THEN agents_completed
              ELSE array_append(agents_completed, ${agent})
            END,
            started_at = COALESCE(started_at, now())
          WHERE id = ${jobId}
        `)
      } else {
        const errorsJson = JSON.stringify([
          {
            agent,
            code: runResult.errorCode,
            message: runResult.message,
          },
        ])
        await db.execute(sql`
          UPDATE generation_jobs
          SET
            result = jsonb_set(
              COALESCE(result, '{}'::jsonb),
              '{errors}',
              COALESCE(result->'errors', '[]'::jsonb) || ${errorsJson}::jsonb
            ),
            agents_completed = CASE
              WHEN ${agent} = ANY(agents_completed) THEN agents_completed
              ELSE array_append(agents_completed, ${agent})
            END,
            started_at = COALESCE(started_at, now())
          WHERE id = ${jobId}
        `)
      }
    })

    // 5. Notify the orchestrator (#41) that this agent has landed.
    await step.sendEvent('agent-done', {
      name: 'generation/agent.completed',
      data: {
        jobId,
        agent,
        ok: runResult.ok,
        errorCode: runResult.ok ? undefined : runResult.errorCode,
      },
    })

    logger.info(
      { jobId, agent, ok: runResult.ok, durationMs: runResult.durationMs },
      'agent completed'
    )
    return { jobId, agent, ok: runResult.ok }
  }
)
