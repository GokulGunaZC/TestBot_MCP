/**
 * Stripe invoice configuration and helpers.
 *
 * Centralises all invoice-related display strings and metadata so that
 * the checkout route and webhook handlers stay in sync automatically.
 */

export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: 'Trial',
  starter: 'Starter',
  team: 'Team',
  enterprise: 'Enterprise',
}

export const PLAN_DESCRIPTIONS: Record<string, string> = {
  starter: 'Healix Starter — 2,500 credits/month · Advanced AI models · Priority support',
  team: 'Healix Team — 10,000 credits/month · CI/CD integration · Priority queue',
  enterprise: 'Healix Enterprise — Unlimited credits · Dedicated infrastructure · 99.9% SLA',
  free: 'Healix Trial — 500 credits/month',
}

/** Human-readable subscription description that appears on Stripe invoices. */
export function invoiceDescription(plan: string): string {
  return PLAN_DESCRIPTIONS[plan] ?? 'Healix Subscription'
}

/** Metadata attached to every invoice for internal traceability. */
export function invoiceMetadata(userId: string, plan: string): Record<string, string> {
  return {
    healix_user_id: userId,
    healix_plan: plan,
    healix_plan_label: PLAN_DISPLAY_NAMES[plan] ?? plan,
  }
}
