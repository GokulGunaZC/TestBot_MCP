import { db } from './db'
import { profiles, tokenLedger } from './db/schema'
import { eq, sql } from 'drizzle-orm'
import { logBlockedRequest } from './security-logger'
import { computeCost, getModelRate } from './pricing'

// Re-export per-model rates so any old caller of computeInternalCost has a
// path forward without an import refactor.
export { computeCost, getModelRate } from './pricing'

// $12 budget at 80% input / 20% output = (0.8×$2.50 + 0.2×$15) = $5.00/1M → $12/$5 × 1M = 2,400,000 tokens
export const TOKENS_PER_PLAN_UNIT = 2_400_000 // real tokens = $12 of OpenAI cost at GPT-5.4 blended rate

// Token budgets per operation. Derived from observed usage in
// mcp_telemetry_events (n=990 calls, 308 runs grouped by user+minute).
//
// MIN_TOKENS_*  — hard floor (p50). Below this we reject the request because
//                 even a typical run won't finish.
// REC_TOKENS_*  — recommended floor (p95). Above this 95% of runs finish
//                 without overage. Between MIN and REC we let the call
//                 through but the UI shows a "may run out" warning.
export const MIN_TOKENS_PLAN       =  10_000  // p50 ~7K
export const REC_TOKENS_PLAN       =  20_000  // p95 ~14K
export const MIN_TOKENS_GENERATE   =  40_000  // p50 ~40K
export const REC_TOKENS_GENERATE   = 120_000  // p95 ~103K
export const MIN_TOKENS_PARSE_PRD  =  20_000  // p50 ~20K
export const REC_TOKENS_PARSE_PRD  =  50_000  // p95 ~42K
export const MIN_TOKENS_ANALYZE    =  20_000  // p50 ~18K
export const REC_TOKENS_ANALYZE    =  45_000  // p95 ~38K

// Re-export the pure display helpers from the client-safe module so any
// server-side caller that used to import from `@/lib/tokens` keeps working.
// Client components MUST import directly from `@/lib/token-units` — this
// file transitively pulls `@/lib/db` (postgres), which Turbopack will not
// bundle into the browser.
export { REAL_TOKENS_PER_DISPLAY_UNIT, toDisplayUnits } from './token-units'

export async function checkTokenBalance(params: {
  userId: string
  endpoint?: string
  minRequired?: number
  recommended?: number
}): Promise<{
  allowed: boolean
  tokensRemaining: number
  reason?: string
  warning?: string
}> {
  const [profile] = await db
    .select({ tokensRemaining: profiles.tokensRemaining })
    .from(profiles)
    .where(eq(profiles.id, params.userId))
    .limit(1)

  const tokensRemaining = profile?.tokensRemaining ?? 0
  const min = params.minRequired ?? 1
  const rec = params.recommended

  if (tokensRemaining < min) {
    const reason = tokensRemaining <= 0
      ? 'No credits remaining. Please upgrade your plan or wait for the next billing cycle.'
      : `Insufficient credits to start this operation (need ${min.toLocaleString()}, have ${tokensRemaining.toLocaleString()}). Please upgrade your plan.`
    logBlockedRequest({
      type: 'NO_TOKENS',
      user_id: params.userId,
      reason,
      endpoint: params.endpoint,
    })
    return { allowed: false, tokensRemaining, reason }
  }

  if (rec && tokensRemaining < rec) {
    return {
      allowed: true,
      tokensRemaining,
      warning: `Low balance: ${tokensRemaining.toLocaleString()} credits remaining. Larger runs may exceed your balance and stop early. Consider upgrading your plan.`,
    }
  }

  return { allowed: true, tokensRemaining }
}

/**
 * Record an AI-call debit. Atomic: locks the user row, decrements balance
 * (floored at 0), and inserts a ledger entry whose `balance_after` matches
 * the new balance. Cost rates are snapshotted from `pricing.ts` at write
 * time so this row stays reproducible if OpenAI changes prices later.
 *
 * Returns the new balance. Non-throwing — if the insert fails the API call
 * still completes (the cost is on us, but we never block a paying customer
 * because of an audit-log glitch).
 */
export async function recordTokenUsage(params: {
  userId: string
  endpoint: string                  // '/api/generate-tests' etc.
  agent: string                     // 'smoke'|'frontend'|'api'|'workflow'|'error'|'expansion'|'planner'|'parse_prd'|'analyze_failures'
  model: string                     // 'gpt-5.4' etc.
  tokensInput: number
  tokensOutput: number
  referenceType?: string | null     // 'test_run' | 'plan' | …
  referenceId?: string | null
  metadata?: Record<string, unknown>
}): Promise<{ balanceAfter: number } | null> {
  const tokensInput  = Math.max(0, Math.floor(params.tokensInput  || 0))
  const tokensOutput = Math.max(0, Math.floor(params.tokensOutput || 0))
  const tokensTotal  = tokensInput + tokensOutput
  if (tokensTotal === 0) return null // nothing to record

  const { costInputUsd, costOutputUsd, costUsd, rate } = computeCost({
    model: params.model,
    tokensInput,
    tokensOutput,
  })

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(profiles)
        .set({ tokensRemaining: sql`GREATEST(0, ${profiles.tokensRemaining} - ${tokensTotal})` })
        .where(eq(profiles.id, params.userId))
        .returning({ tokensRemaining: profiles.tokensRemaining })

      const balanceAfter = row?.tokensRemaining ?? 0

      await tx.insert(tokenLedger).values({
        userId: params.userId,
        entryType: 'debit',
        endpoint: params.endpoint,
        agent: params.agent,
        model: params.model,
        tokensInput,
        tokensOutput,
        tokensTotal,
        tokensDelta: -tokensTotal,
        balanceAfter,
        inputRateUsd:  rate.inputUsdPerToken.toFixed(12),
        outputRateUsd: rate.outputUsdPerToken.toFixed(12),
        costInputUsd:  costInputUsd.toFixed(8),
        costOutputUsd: costOutputUsd.toFixed(8),
        costUsd:       costUsd.toFixed(8),
        referenceType: params.referenceType ?? null,
        referenceId:   params.referenceId ?? null,
        metadata:      params.metadata ?? null,
      })

      return { balanceAfter }
    })
  } catch (err) {
    // Do not throw — caller should not fail a request because the audit log
    // hiccupped. The balance update is part of the same transaction so a
    // failure here means the deduction also rolled back; on retry we'll try
    // again. Surface to logs only.
    console.warn('[recordTokenUsage] failed', err)
    return null
  }
}

/**
 * Record a token credit (top-up). Atomic: increments balance and inserts a
 * `credit` ledger entry. Use this from the Stripe webhook on
 * `checkout.session.completed` and from any manual-grant tooling.
 */
export async function recordTokenCredit(params: {
  userId: string
  tokensGranted: number
  referenceType: string             // 'stripe_payment' | 'plan' | 'manual'
  referenceId: string | null
  metadata?: Record<string, unknown>
}): Promise<{ balanceAfter: number } | null> {
  const tokensGranted = Math.max(0, Math.floor(params.tokensGranted || 0))
  if (tokensGranted === 0) return null

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(profiles)
        .set({ tokensRemaining: sql`${profiles.tokensRemaining} + ${tokensGranted}` })
        .where(eq(profiles.id, params.userId))
        .returning({ tokensRemaining: profiles.tokensRemaining })

      const balanceAfter = row?.tokensRemaining ?? tokensGranted

      await tx.insert(tokenLedger).values({
        userId: params.userId,
        entryType: 'credit',
        endpoint: null,
        agent: null,
        model: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensTotal: tokensGranted,
        tokensDelta: tokensGranted,
        balanceAfter,
        inputRateUsd: null,
        outputRateUsd: null,
        costInputUsd: null,
        costOutputUsd: null,
        costUsd: null,
        referenceType: params.referenceType,
        referenceId:   params.referenceId,
        metadata:      params.metadata ?? null,
      })

      return { balanceAfter }
    })
  } catch (err) {
    console.warn('[recordTokenCredit] failed', err)
    return null
  }
}

/**
 * @deprecated Prefer `recordTokenUsage` which writes to the ledger. This is
 * still here for any caller that has only a total (no input/output split).
 * It updates `profiles.tokens_remaining` only — no audit row. Once all
 * callers move to `recordTokenUsage` this can be deleted.
 */
export async function deductTokens(params: {
  userId: string
  tokensUsed: number
}): Promise<void> {
  await db
    .update(profiles)
    .set({ tokensRemaining: sql`GREATEST(0, tokens_remaining - ${params.tokensUsed})` })
    .where(eq(profiles.id, params.userId))
}

/**
 * @deprecated Use `computeCost` from `./pricing` directly. Kept so older
 * callers (ai-guard.ts) keep compiling during the rollout.
 */
export function computeInternalCost(promptTokens: number, completionTokens: number): number {
  return computeCost({ model: 'gpt-5.4', tokensInput: promptTokens, tokensOutput: completionTokens }).costUsd
}
