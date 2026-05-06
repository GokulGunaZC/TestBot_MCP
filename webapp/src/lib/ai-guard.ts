import { db } from './db'
import { mcpTelemetryEvents } from './db/schema'
import { eq, and, gte, count } from 'drizzle-orm'
import { logBlockedRequest, logAiCostSpike } from './security-logger'
import { computeInternalCost } from './tokens'

const AI_MAX_REQUESTS_PER_MINUTE = parseInt(process.env.AI_MAX_REQUESTS_PER_MINUTE ?? '20', 10)

export async function checkAiGuard(params: {
  userId: string
  endpoint?: string
}): Promise<{ allowed: boolean }> {
  const windowStart = new Date(Date.now() - 60_000)

  const [{ requestCount }] = await db
    .select({ requestCount: count() })
    .from(mcpTelemetryEvents)
    .where(
      and(
        eq(mcpTelemetryEvents.userId, params.userId),
        eq(mcpTelemetryEvents.eventType, 'ai_call'),
        gte(mcpTelemetryEvents.occurredAt, windowStart)
      )
    )

  if (requestCount >= AI_MAX_REQUESTS_PER_MINUTE) {
    logAiCostSpike({
      user_id: params.userId,
      endpoint: params.endpoint ?? 'unknown',
      requests_in_window: requestCount,
      limit: AI_MAX_REQUESTS_PER_MINUTE,
    })
    logBlockedRequest({
      type: 'AI_COST_SPIKE_DETECTED',
      user_id: params.userId,
      reason: `AI requests in last 60s (${requestCount}) >= limit (${AI_MAX_REQUESTS_PER_MINUTE})`,
      endpoint: params.endpoint,
      metadata: { requestCount, limit: AI_MAX_REQUESTS_PER_MINUTE },
    })
    return { allowed: false }
  }

  return { allowed: true }
}

export async function recordAiCall(params: {
  userId: string
  apiKeyId: string
  endpoint: string
  modelUsed?: string
  tokensPrompt?: number
  tokensCompletion?: number
  tokensTotal?: number
  // NEW: per-agent attribution. When present, this row becomes queryable as
  //   SELECT agent, SUM(tokens_total), AVG(latency_ms) FROM mcp_telemetry_events GROUP BY agent
  // which drives the per-agent dashboards and prompt-tuning workflow.
  agent?: string
  latencyMs?: number
  success?: boolean
  errorCode?: string | null
  runId?: string | null
}): Promise<void> {
  try {
    const costUsd =
      params.tokensPrompt !== undefined && params.tokensCompletion !== undefined
        ? computeInternalCost(params.tokensPrompt, params.tokensCompletion).toFixed(8)
        : null
    const success = params.success ?? true
    await db.insert(mcpTelemetryEvents).values({
      userId: params.userId,
      apiKeyId: params.apiKeyId,
      source: 'healix-webapp',
      toolName: params.endpoint,
      eventType: 'ai_call',
      status: success ? 'info' : 'error',
      success,
      errorCode: params.errorCode ?? null,
      runId: params.runId ?? null,
      modelUsed: params.modelUsed ?? null,
      tokensPrompt: params.tokensPrompt ?? null,
      tokensCompletion: params.tokensCompletion ?? null,
      tokensTotal: params.tokensTotal ?? null,
      costUsd: costUsd,
      agent: params.agent ?? null,
      latencyMs: Number.isFinite(params.latencyMs) ? params.latencyMs! : null,
    })
  } catch {
    // Non-blocking — don't fail the request if this insert fails
  }
}
