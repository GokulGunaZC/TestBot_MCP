import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getCurrentProfile } from '@/lib/auth/session'
import { PLAN_RANK, PLAN_TOKEN_TOTALS } from '@/lib/plans'

export async function POST(request: NextRequest) {
  try {
    const result = await getCurrentProfile()
    if (!result?.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { plan } = await request.json()
    if (!plan || PLAN_RANK[plan] === undefined) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const currentRank = PLAN_RANK[result.profile.plan ?? 'free']
    const targetRank = PLAN_RANK[plan]

    if (targetRank >= currentRank) {
      return NextResponse.json({ error: 'Use Stripe checkout to upgrade' }, { status: 400 })
    }

    // tokensTotal = plan's advertised allocation (drives the "/50" in the meter).
    // tokensRemaining is NOT touched — user keeps their paid-for balance.
    const planTokenTotal = PLAN_TOKEN_TOTALS[plan] ?? PLAN_TOKEN_TOTALS.free
    const [updated] = await db
      .update(profiles)
      .set({ plan, tokensTotal: planTokenTotal, updatedAt: new Date() })
      .where(eq(profiles.id, result.user.id))
      .returning()

    return NextResponse.json({ data: { plan: updated.plan } })
  } catch (error) {
    console.error('Plan downgrade error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
