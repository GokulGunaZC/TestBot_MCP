import { NextResponse } from 'next/server'
import { getCurrentProfile } from '@/lib/auth/session'
import { getStripe } from '@/lib/stripe'

export async function POST() {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
    }

    const result = await getCurrentProfile()
    if (!result?.profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const customerId = result.profile.stripeCustomerId
    if (!customerId) {
      return NextResponse.json({ error: 'No billing account found' }, { status: 400 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/plan-billing`,
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Stripe portal error:', error)
    return NextResponse.json({ error: 'Failed to open billing portal' }, { status: 500 })
  }
}
