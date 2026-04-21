import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const PLAN_TOKEN_TOTALS: Record<string, number> = {
  free: 240_000,
  starter: 2_400_000,
  team: 4_800_000,
}

export async function POST(request: NextRequest) {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!stripeKey || !webhookSecret) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' })

  const body = await request.text()
  const sig = request.headers.get('stripe-signature')

  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session

    const plan = session.metadata?.plan
    const userId = session.metadata?.userId ?? session.client_reference_id

    if (!plan || !userId || !PLAN_TOKEN_TOTALS[plan]) {
      console.error('Stripe webhook: missing plan or userId in session metadata', session.id)
      return NextResponse.json({ error: 'Missing metadata' }, { status: 400 })
    }

    const tokenTotal = PLAN_TOKEN_TOTALS[plan]

    await db
      .update(profiles)
      .set({
        plan,
        tokensTotal: tokenTotal,
        tokensRemaining: tokenTotal,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId))

    console.log(`[STRIPE WEBHOOK] Plan updated: userId=${userId} → plan=${plan}`)
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription
    const userId = subscription.metadata?.userId

    if (userId) {
      await db
        .update(profiles)
        .set({
          plan: 'free',
          tokensTotal: PLAN_TOKEN_TOTALS.free,
          tokensRemaining: PLAN_TOKEN_TOTALS.free,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, userId))

      console.log(`[STRIPE WEBHOOK] Subscription cancelled: userId=${userId} → reverted to free`)
    }
  }

  return NextResponse.json({ received: true })
}
