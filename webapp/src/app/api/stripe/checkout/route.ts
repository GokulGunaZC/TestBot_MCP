import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getCurrentProfile } from '@/lib/auth/session'

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  team: process.env.STRIPE_PRICE_TEAM ?? '',
}

export async function POST(request: NextRequest) {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey) {
      return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
    }

    const result = await getCurrentProfile()
    if (!result?.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { plan } = await request.json()
    if (!plan || !PLAN_PRICE_IDS[plan]) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const priceId = PLAN_PRICE_IDS[plan]
    if (!priceId) {
      return NextResponse.json({ error: `Stripe price ID for plan "${plan}" not configured` }, { status: 503 })
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: result.profile.id,
      customer_email: result.profile.email,
      metadata: { plan, userId: result.profile.id },
      success_url: `${appUrl}/plan-billing?payment=success&plan=${plan}`,
      cancel_url: `${appUrl}/plan-billing?payment=cancelled`,
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}
