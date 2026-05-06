// Pure client-safe token-display helpers. Lives in its own file so client
// components (`home/page.tsx`, `plan-billing/page.tsx`, `Sidebar.tsx`) can
// import them without pulling `@/lib/tokens` — which transitively imports
// `@/lib/db` (postgres/fs), something Turbopack refuses to bundle into the
// browser.
//
// If you need `checkTokenBalance` / `deductTokens` (server-only, DB-bound),
// import from `@/lib/tokens` in a server component or route handler instead.

// Display units — shared across the sidebar, the home-page plan card, and the
// billing page so they can never diverge. 1 display unit = 4,800 real tokens,
// chosen so a $12 Starter plan (2.4M real tokens) shows 500 units and a $24
// Team plan (4.8M real tokens) shows 1,000 units.
export const REAL_TOKENS_PER_DISPLAY_UNIT = 4_800

export function toDisplayUnits(realTokens: number | null | undefined): number {
  if (realTokens == null || !Number.isFinite(realTokens) || realTokens <= 0) return 0
  return Math.floor(realTokens / REAL_TOKENS_PER_DISPLAY_UNIT)
}
