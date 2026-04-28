// Single source of truth for plan configuration.
// All API routes and the billing page derive from here.

export const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  team: process.env.STRIPE_PRICE_TEAM ?? '',
}

export const PLAN_TOKEN_TOTALS: Record<string, number> = {
  free: 2_400_000,      // 500 credits/month
  starter: 12_000_000,  // 2,500 credits/month
  team: 48_000_000,     // 10,000 credits/month
}

export const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  team: 2,
  enterprise: 3,
}

/** Resolve Stripe price ID → internal plan name. Returns null if unmapped. */
export function planFromPriceId(priceId: string): string | null {
  for (const [plan, id] of Object.entries(PLAN_PRICE_IDS)) {
    if (id && id === priceId) return plan
  }
  return null
}
