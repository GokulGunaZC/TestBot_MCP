import { db } from './db'
import { profiles } from './db/schema'
import { and, eq, gt, sql } from 'drizzle-orm'
import { logBlockedRequest } from './security-logger'

export async function deductCredit(params: {
  userId: string
  endpoint: string
}): Promise<{ allowed: boolean; creditsRemaining: number }> {
  // Atomic decrement — only succeeds when credits_remaining > 0.
  // Using a single UPDATE … WHERE … RETURNING eliminates the read-then-write
  // race condition and is fail-closed: any DB error propagates as a thrown
  // exception which the caller must NOT swallow.
  const rows = await db
    .update(profiles)
    .set({ creditsRemaining: sql`credits_remaining - 1` })
    .where(and(eq(profiles.id, params.userId), gt(profiles.creditsRemaining, 0)))
    .returning({ creditsRemaining: profiles.creditsRemaining })

  if (rows.length === 0) {
    logBlockedRequest({
      type: 'NO_CREDITS',
      user_id: params.userId,
      reason: 'credits_remaining is 0 or user not found',
      endpoint: params.endpoint,
    })
    return { allowed: false, creditsRemaining: 0 }
  }

  return { allowed: true, creditsRemaining: rows[0].creditsRemaining ?? 0 }
}
