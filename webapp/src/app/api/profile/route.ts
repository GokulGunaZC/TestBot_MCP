import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getCurrentProfile } from '@/lib/auth/session'
import { PLAN_TOKEN_TOTALS } from '@/lib/plans'

function mapProfileToSnakeCase(profile: typeof profiles.$inferSelect) {
  return {
    id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    avatar_url: profile.avatarUrl,
    company: profile.company,
    role: profile.role,
    plan: profile.plan,
    credits_remaining: profile.creditsRemaining,
    credits_total: profile.creditsTotal,
    tokens_remaining: profile.tokensRemaining ?? 0,
    tokens_total: profile.tokensTotal ?? 0,
    onboarding_completed: profile.onboardingCompleted,
    stripe_customer_id: profile.stripeCustomerId ?? null,
    stripe_subscription_id: profile.stripeSubscriptionId ?? null,
    subscription_status: profile.subscriptionStatus ?? 'inactive',
    created_at: profile.createdAt?.toISOString() ?? null,
    updated_at: profile.updatedAt?.toISOString() ?? null,
  }
}

export async function GET() {
  try {
    const result = await getCurrentProfile()
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!result.profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    let profile = result.profile
    const expectedTotal = PLAN_TOKEN_TOTALS[profile.plan ?? 'free']
    if (expectedTotal !== undefined && profile.tokensTotal !== expectedTotal) {
      // If the user hasn't spent any tokens yet (remaining >= total), bump both
      // so the meter shows the correct full allocation after a plan token update.
      // If they have spent tokens, only update the denominator (total) and leave
      // remaining intact so we don't silently refill a partially-used balance.
      const noTokensUsed = (profile.tokensRemaining ?? 0) >= (profile.tokensTotal ?? 0)
      const [fixed] = await db
        .update(profiles)
        .set({
          tokensTotal: expectedTotal,
          ...(noTokensUsed ? { tokensRemaining: expectedTotal } : {}),
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, profile.id))
        .returning()
      profile = fixed
    }

    return NextResponse.json({ data: mapProfileToSnakeCase(profile) })
  } catch (error) {
    console.error('Profile GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const result = await getCurrentProfile()
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { full_name, company } = body

    const [updatedProfile] = await db
      .update(profiles)
      .set({
        fullName: full_name ?? undefined,
        company: company ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, result.user.id))
      .returning()

    return NextResponse.json({ data: mapProfileToSnakeCase(updatedProfile) })
  } catch (error) {
    console.error('Profile PATCH error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
