import { db } from './db'
import { testRuns } from './db/schema'
import { eq, and, count } from 'drizzle-orm'
import { logBlockedRequest } from './security-logger'

const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS ?? '3', 10)

export async function checkConcurrencyLimit(params: {
  userId: string
  endpoint?: string
}): Promise<{ allowed: boolean; activeCount: number }> {
  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(testRuns)
    .where(and(eq(testRuns.userId, params.userId), eq(testRuns.status, 'running')))

  if (activeCount >= MAX_CONCURRENT_RUNS) {
    logBlockedRequest({
      type: 'CONCURRENT_LIMIT_EXCEEDED',
      user_id: params.userId,
      reason: `Active runs (${activeCount}) >= limit (${MAX_CONCURRENT_RUNS})`,
      endpoint: params.endpoint,
      metadata: { activeCount, limit: MAX_CONCURRENT_RUNS },
    })
    return { allowed: false, activeCount }
  }

  return { allowed: true, activeCount }
}
