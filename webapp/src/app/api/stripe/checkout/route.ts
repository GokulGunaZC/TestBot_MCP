import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getCurrentProfile } from '@/lib/auth/session'
import { getStripe } from '@/lib/stripe'
import { PLAN_PRICE_IDS } from '@/lib/plans'
import { invoiceDescription, invoiceMetadata } from '@/lib/stripe-invoice'

export async function POST(request: NextRequest) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
    }

    const result = await getCurrentProfile()
    if (!result?.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { plan } = await request.json()
    const priceId = PLAN_PRICE_IDS[plan]
    if (!plan || !priceId) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const stripe = getStripe()
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const profile = result.profile

    // Reuse existing Stripe customer to preserve payment methods and billing history.
    let customerId: string
    if (profile.stripeCustomerId) {
      customerId = profile.stripeCustomerId
    } else {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { userId: profile.id },
      })
      customerId = customer.id
      await db
        .update(profiles)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id))
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: profile.id,
      metadata: { plan, userId: profile.id },

      // Disable promotion codes — we don't run discount campaigns.
      allow_promotion_codes: false,

      subscription_data: {
        description: invoiceDescription(plan),
        metadata: { plan, userId: profile.id, ...invoiceMetadata(profile.id, plan) },
      },

      success_url: `${appUrl}/plan-billing?payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/plan-billing?payment=cancelled`,
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}
