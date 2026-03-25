import { db } from './db'
import { mcpTelemetryEvents } from './db/schema'
import { eq, and, gte, count } from 'drizzle-orm'
import { logBlockedRequest, logAiCostSpike } from './security-logger'

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
}): Promise<void> {
  try {
    await db.insert(mcpTelemetryEvents).values({
      userId: params.userId,
      apiKeyId: params.apiKeyId,
      source: 'testbot-webapp',
      toolName: params.endpoint,
      eventType: 'ai_call',
      status: 'info',
      success: true,
    })
  } catch {
    // Non-blocking — don't fail the request if this insert fails
  }
}
