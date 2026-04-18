import { db } from './db'
import { profiles } from './db/schema'
import { eq, sql } from 'drizzle-orm'
import { logBlockedRequest } from './security-logger'

const GPT54_INPUT_COST_PER_TOKEN  = 2.50  / 1_000_000  // $0.0000025  per input token
const GPT54_OUTPUT_COST_PER_TOKEN = 15.00 / 1_000_000  // $0.000015   per output token
// $12 budget at 80% input / 20% output = (0.8×$2.50 + 0.2×$15) = $5.00/1M → $12/$5 × 1M = 2,400,000 tokens
export const TOKENS_PER_PLAN_UNIT = 2_400_000 // real tokens = $12 of OpenAI cost at GPT-5.4 blended rate

// Re-export the pure display helpers from the client-safe module so any
// server-side caller that used to import from `@/lib/tokens` keeps working.
// Client components MUST import directly from `@/lib/token-units` — this
// file transitively pulls `@/lib/db` (postgres), which Turbopack will not
// bundle into the browser.
export { REAL_TOKENS_PER_DISPLAY_UNIT, toDisplayUnits } from './token-units'

export async function checkTokenBalance(params: {
  userId: string
  endpoint?: string
}): Promise<{ allowed: boolean; tokensRemaining: number }> {
  const [profile] = await db
    .select({ tokensRemaining: profiles.tokensRemaining })
    .from(profiles)
    .where(eq(profiles.id, params.userId))
    .limit(1)

  const tokensRemaining = profile?.tokensRemaining ?? 0

  if (tokensRemaining <= 0) {
    logBlockedRequest({
      type: 'NO_TOKENS',
      user_id: params.userId,
      reason: 'tokens_remaining is 0 or user not found',
      endpoint: params.endpoint,
    })
    return { allowed: false, tokensRemaining: 0 }
  }

  return { allowed: true, tokensRemaining }
}

export async function deductTokens(params: {
  userId: string
  tokensUsed: number
}): Promise<void> {
  // Atomic decrement — allows slight negative since deduction happens post-call.
  // This is intentional: we can't know exact usage before the call completes.
  await db
    .update(profiles)
    .set({ tokensRemaining: sql`tokens_remaining - ${params.tokensUsed}` })
    .where(eq(profiles.id, params.userId))
}

export function computeInternalCost(promptTokens: number, completionTokens: number): number {
  const cost =
    promptTokens * GPT54_INPUT_COST_PER_TOKEN +
    completionTokens * GPT54_OUTPUT_COST_PER_TOKEN
  return parseFloat(cost.toFixed(8))
}
