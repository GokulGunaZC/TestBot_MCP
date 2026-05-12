/**
 * Test account setup script for adarshgadekar@gmail.com
 * Sets the account to a specific gating scenario for manual/Playwright testing.
 *
 * Usage:
 *   npx tsx scripts/setup-test-account.ts <scenario>
 *
 * Scenarios:
 *   reset         - Baseline: starter plan, 100 credits, onboarding done
 *   no-credits    - credits_remaining=0  → tests 402 credit gate
 *   low-credits   - credits_remaining=1  → tests last-credit behaviour
 *   pro           - plan=pro, 1000 credits → tests pro plan access
 *   no-onboarding - onboarding_completed=false → tests onboarding gate
 *   show          - Print current profile state (no changes)
 */

import postgres from 'postgres'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.join(__dirname, '..', '.env.local') })

const TEST_EMAIL = 'adarshgadekar@gmail.com'

const SCENARIOS: Record<string, {
  description: string
  updates: Record<string, unknown>
}> = {
  reset: {
    description: 'Baseline — free plan, 240K tokens, onboarding complete',
    updates: { plan: 'free', credits_remaining: 100, credits_total: 100, tokens_remaining: 240000, tokens_total: 240000, onboarding_completed: true },
  },
  'no-tokens': {
    description: 'Zero tokens → token gate should return 402',
    updates: { tokens_remaining: 0 },
  },
  'no-credits': {
    description: 'Zero credits (legacy) — kept for backwards compat',
    updates: { credits_remaining: 0 },
  },
  starter: {
    description: 'Starter plan — 2.4M tokens ($15/month, model cost based on gpt-5.5-mini)',
    updates: { plan: 'starter', tokens_remaining: 2400000, tokens_total: 2400000 },
  },
  'no-onboarding': {
    description: 'Onboarding not completed',
    updates: { onboarding_completed: false },
  },
  show: {
    description: 'Print current account state without making changes',
    updates: {},
  },
}

async function main() {
  const scenario = process.argv[2]

  if (!scenario || !SCENARIOS[scenario]) {
    console.error(`\nUsage: npx tsx scripts/setup-test-account.ts <scenario>\n`)
    console.error('Available scenarios:')
    for (const [name, { description }] of Object.entries(SCENARIOS)) {
      console.error(`  ${name.padEnd(16)} ${description}`)
    }
    process.exit(1)
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('❌  DATABASE_URL not set in .env.local')
    process.exit(1)
  }

  const sql = postgres(dbUrl, { ssl: { rejectUnauthorized: false } })

  try {
    const [profile] = await sql`
      SELECT id, email, plan, credits_remaining, credits_total, tokens_remaining, tokens_total, onboarding_completed, role
      FROM profiles
      WHERE email = ${TEST_EMAIL}
      LIMIT 1
    `

    if (!profile) {
      console.error(`❌  User ${TEST_EMAIL} not found in profiles table`)
      process.exit(1)
    }

    const { updates } = SCENARIOS[scenario]

    if (scenario !== 'show' && Object.keys(updates).length > 0) {
      await sql`
        UPDATE profiles
        SET ${sql(updates as Record<string, unknown>, ...Object.keys(updates))}, updated_at = NOW()
        WHERE id = ${profile.id as string}
      `
      console.log(`\n✅  Applied scenario: ${scenario}`)
      console.log(`   ${SCENARIOS[scenario].description}`)
    }

    const [updated] = await sql`
      SELECT id, email, plan, credits_remaining, credits_total, tokens_remaining, tokens_total, onboarding_completed, role, updated_at
      FROM profiles
      WHERE id = ${profile.id as string}
    `

    console.log('\n── Current account state ───────────────────────────────')
    console.log(`  email              ${updated.email}`)
    console.log(`  id                 ${updated.id}`)
    console.log(`  plan               ${updated.plan}`)
    console.log(`  tokens_remaining   ${updated.tokens_remaining}`)
    console.log(`  tokens_total       ${updated.tokens_total}`)
    console.log(`  credits_remaining  ${updated.credits_remaining}`)
    console.log(`  onboarding         ${updated.onboarding_completed ? 'completed' : 'NOT completed'}`)
    console.log(`  role               ${updated.role}`)
    console.log(`  updated_at         ${updated.updated_at}`)
    console.log('────────────────────────────────────────────────────────\n')

    const [keyRows] = await sql`
      SELECT count(*)::int AS total,
             sum(CASE WHEN is_active AND NOT revoked THEN 1 ELSE 0 END)::int AS active
      FROM api_keys
      WHERE user_id = ${profile.id as string}
    `
    console.log(`  api_keys           ${keyRows.active} active / ${keyRows.total} total\n`)

  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('❌  Script error:', err.message)
  process.exit(1)
})
