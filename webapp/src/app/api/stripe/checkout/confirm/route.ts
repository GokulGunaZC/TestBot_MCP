import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getCurrentProfile } from '@/lib/auth/session'
import { getStripe } from '@/lib/stripe'
import { PLAN_TOKEN_TOTALS } from '@/lib/plans'
import { sendEmail, EMAIL_CONFIG } from '@/lib/email'
import { buildCustomerEmail, buildAdminEmail } from '@/lib/email-templates'

/**
 * POST /api/stripe/checkout/confirm
 *
 * Called by the billing page immediately after the Stripe success redirect.
 * Retrieves the checkout session from Stripe to verify payment, then applies
 * the plan update and sends confirmation emails synchronously — without
 * waiting for the async webhook to arrive.
 *
 * The webhook handler remains the authoritative processor for production
 * events. Both are idempotent: whichever runs second will see the
 * stripeSubscriptionId already set and skip the update.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await getCurrentProfile()
    if (!result?.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { sessionId } = await request.json()
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
    }

    const session = await getStripe().checkout.sessions.retrieve(sessionId)

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 })
    }

    // Verify the session belongs to the authenticated user
    const userId = session.metadata?.userId ?? session.client_reference_id
    if (!userId || userId !== result.profile.id) {
      return NextResponse.json({ error: 'Session does not belong to this user' }, { status: 403 })
    }

    const plan = session.metadata?.plan
    const tokenTotal = plan ? PLAN_TOKEN_TOTALS[plan] : null
    if (!plan || !tokenTotal) {
      return NextResponse.json({ error: 'Invalid plan in session' }, { status: 400 })
    }

    const customerId = typeof session.customer === 'string' ? session.customer : null
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null

    // Idempotency: if the webhook already processed this subscription, skip the update
    if (subscriptionId && result.profile.stripeSubscriptionId === subscriptionId) {
      return NextResponse.json({ updated: false })
    }

    // Preserve any token balance the user already has if it exceeds the new
    // plan's allocation (e.g. downgraded from Team then re-upgraded to Starter
    // while still holding 1000 credits — don't wipe those down to 500).
    const tokensToGrant = Math.max(result.profile.tokensRemaining ?? 0, tokenTotal)

    await db
      .update(profiles)
      .set({
        plan,
        tokensTotal: tokenTotal,
        tokensRemaining: tokensToGrant,
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId ?? undefined,
        subscriptionStatus: 'active',
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId))

    const [updated] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)
    if (updated) {
      const emailPayload = {
        customerEmail: updated.email,
        customerName: updated.fullName ?? undefined,
        plan,
        tokensGranted: tokenTotal,
        stripeCustomerId: customerId ?? '',
        stripeSubscriptionId: subscriptionId ?? '',
      }
      const [customerSent, adminSent] = await Promise.all([
        sendEmail({ ...buildCustomerEmail(emailPayload), to: updated.email }),
        EMAIL_CONFIG.adminEmail
          ? sendEmail({ ...buildAdminEmail(emailPayload), to: EMAIL_CONFIG.adminEmail })
          : Promise.resolve(false),
      ])
      if (!customerSent) console.error('[CONFIRM] Customer receipt email failed for:', updated.email)
      if (EMAIL_CONFIG.adminEmail && !adminSent) console.error('[CONFIRM] Admin notification email failed for:', EMAIL_CONFIG.adminEmail)
    }

    return NextResponse.json({ updated: true })
  } catch (error) {
    console.error('[STRIPE] Checkout confirm error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
