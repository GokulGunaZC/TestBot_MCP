import { db } from './db'
import { testRuns, mcpTelemetryEvents, userFlags, apiKeys } from './db/schema'
import { eq, and, gte, count } from 'drizzle-orm'
import { logAbuseFlag } from './security-logger'

const ABUSE_RUNS_PER_HOUR = parseInt(process.env.ABUSE_RUNS_PER_HOUR ?? '100', 10)
const ABUSE_AUTO_BLOCK = process.env.ABUSE_AUTO_BLOCK === 'true'

async function flagUser(params: {
  userId: string
  type: string
  reason: string
  metadata?: Record<string, unknown>
}) {
  logAbuseFlag({ user_id: params.userId, type: params.type, reason: params.reason, metadata: params.metadata })
  try {
    await db.insert(userFlags).values({
      userId: params.userId,
      type: params.type,
      reason: params.reason,
      metadata: params.metadata,
    })
  } catch {
    // Non-blocking
  }

  if (ABUSE_AUTO_BLOCK) {
    try {
      await db
        .update(apiKeys)
        .set({ revoked: true })
        .where(eq(apiKeys.userId, params.userId))
    } catch {
      // Non-blocking
    }
  }
}

export async function runAbuseDetection(params: {
  userId: string
  apiKeyId?: string
}): Promise<void> {
  const hourAgo = new Date(Date.now() - 3_600_000)

  try {
    // Check 1: Too many test runs in the last hour
    const [{ runCount }] = await db
      .select({ runCount: count() })
      .from(testRuns)
      .where(and(eq(testRuns.userId, params.userId), gte(testRuns.createdAt, hourAgo)))

    if (runCount >= ABUSE_RUNS_PER_HOUR) {
      await flagUser({
        userId: params.userId,
        type: 'HIGH_RUN_FREQUENCY',
        reason: `${runCount} test runs in last hour (threshold: ${ABUSE_RUNS_PER_HOUR})`,
        metadata: { runCount, threshold: ABUSE_RUNS_PER_HOUR },
      })
    }

    // Check 2: High failure rate (last 20 runs)
    const recentRuns = await db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.userId, params.userId))
      .orderBy(testRuns.createdAt)
      .limit(20)

    if (recentRuns.length >= 10) {
      const failedCount = recentRuns.filter((r) => r.status === 'failed' || r.status === 'error').length
      const failRate = failedCount / recentRuns.length
      if (failRate > 0.8) {
        await flagUser({
          userId: params.userId,
          type: 'HIGH_FAILURE_RATE',
          reason: `${Math.round(failRate * 100)}% failure rate in last ${recentRuns.length} runs`,
          metadata: { failedCount, totalChecked: recentRuns.length, failRate },
        })
      }
    }

    // Check 3: AI token usage spike (5x rolling average)
    const minuteAgo = new Date(Date.now() - 60_000)
    const [{ recentAiCalls }] = await db
      .select({ recentAiCalls: count() })
      .from(mcpTelemetryEvents)
      .where(
        and(
          eq(mcpTelemetryEvents.userId, params.userId),
          eq(mcpTelemetryEvents.eventType, 'ai_call'),
          gte(mcpTelemetryEvents.occurredAt, minuteAgo)
        )
      )

    const dayAgo = new Date(Date.now() - 86_400_000)
    const [{ dailyAiCalls }] = await db
      .select({ dailyAiCalls: count() })
      .from(mcpTelemetryEvents)
      .where(
        and(
          eq(mcpTelemetryEvents.userId, params.userId),
          eq(mcpTelemetryEvents.eventType, 'ai_call'),
          gte(mcpTelemetryEvents.occurredAt, dayAgo)
        )
      )

    const dailyAvgPerMinute = dailyAiCalls / 1440
    if (dailyAvgPerMinute > 0 && recentAiCalls > dailyAvgPerMinute * 5) {
      await flagUser({
        userId: params.userId,
        type: 'AI_USAGE_SPIKE',
        reason: `AI calls in last minute (${recentAiCalls}) is 5x daily average (${dailyAvgPerMinute.toFixed(2)}/min)`,
        metadata: { recentAiCalls, dailyAvgPerMinute },
      })
    }
  } catch {
    // Abuse detection is non-blocking — never throw
  }
}
