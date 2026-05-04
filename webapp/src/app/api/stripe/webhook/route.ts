import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { profiles, payments, tokenLedger } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getStripe } from '@/lib/stripe'
import { PLAN_TOKEN_TOTALS } from '@/lib/plans'
import { invoiceDescription, invoiceMetadata } from '@/lib/stripe-invoice'
import { sendEmail, EMAIL_CONFIG } from '@/lib/email'
import { buildCustomerEmail, buildAdminEmail } from '@/lib/email-templates'

// Webhook signature verification requires the raw body — never parse as JSON first.
export const config = { api: { bodyParser: false } }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a profile by Stripe customer ID. Returns null if not found. */
async function profileByCustomer(customerId: string) {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.stripeCustomerId, customerId))
    .limit(1)
  return profile ?? null
}

/** Look up a profile by internal user ID. Returns null if not found. */
async function profileByUserId(userId: string) {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)
  return profile ?? null
}

/**
 * In the 2026-03-25.dahlia API, invoice.subscription was removed.
 * The subscription ID now lives at invoice.parent.subscription_details.subscription.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription
  if (!sub) return null
  return typeof sub === 'string' ? sub : sub.id
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed
 *
 * Fires when the user completes the Stripe Checkout flow — but for bank
 * payments (ACH) the money has NOT settled yet. We check payment_status:
 *
 *   'paid'    → card payment, settled immediately → grant tokens now
 *   'unpaid'  → bank payment, pending settlement  → store IDs + plan only,
 *               tokens granted later by invoice.paid (subscription_create)
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session, event: Stripe.Event) {
  const plan = session.metadata?.plan
  const userId = session.metadata?.userId ?? session.client_reference_id
  const customerId = typeof session.customer === 'string' ? session.customer : null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
  const isPaid = session.payment_status === 'paid'
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null

  if (!plan || !userId) {
    console.error('[STRIPE] checkout.session.completed: missing plan or userId', session.id)
    return
  }

  const tokenTotal = PLAN_TOKEN_TOTALS[plan]
  if (!tokenTotal) {
    console.error('[STRIPE] checkout.session.completed: unknown plan', plan)
    return
  }

  // Fetch existing profile for idempotency check and token preservation.
  const existing = await profileByUserId(userId)

  // Idempotency: if the subscription ID is already stored, this event was
  // already processed (e.g. Stripe retry). Safe to skip.
  if (subscriptionId && existing?.stripeSubscriptionId === subscriptionId) {
    console.log('[STRIPE] checkout.session.completed: already processed, skipping', session.id)
    return
  }

  // Preserve any token balance higher than the new plan's allocation.
  // Example: user had Team (1000 credits), downgraded to Trial (kept 1000),
  // then re-upgraded to Starter (500/mo) — they should keep their 1000.
  const tokensToGrant = Math.max(existing?.tokensRemaining ?? 0, tokenTotal)

  // Single transaction: profile update + payment row + (paid path only) ledger
  // credit. Pending bank payments record the payment row in 'pending' state but
  // skip the ledger entry until invoice.paid confirms settlement.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(profiles)
      .set({
        plan,
        ...(isPaid ? { tokensTotal: tokenTotal, tokensRemaining: tokensToGrant } : {}),
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId ?? undefined,
        subscriptionStatus: isPaid ? 'active' : 'pending_payment',
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId))
      .returning({ tokensRemaining: profiles.tokensRemaining })

    const [payment] = await tx
      .insert(payments)
      .values({
        userId,
        provider: 'stripe',
        providerPaymentId: paymentIntentId,
        providerCustomerId: customerId,
        providerSessionId: session.id,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? 'usd').toLowerCase(),
        status: isPaid ? 'succeeded' : 'pending',
        plan,
        tokensGranted: isPaid ? tokenTotal : 0,
        rawEvent: event as unknown as Record<string, unknown>,
      })
      .returning({ id: payments.id })

    if (isPaid) {
      await tx.insert(tokenLedger).values({
        userId,
        entryType: 'credit',
        endpoint: null,
        agent: null,
        model: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensTotal: tokenTotal,
        tokensDelta: tokenTotal,
        balanceAfter: updated?.tokensRemaining ?? tokenTotal,
        inputRateUsd: null,
        outputRateUsd: null,
        costInputUsd: null,
        costOutputUsd: null,
        costUsd: null,
        referenceType: 'stripe_payment',
        referenceId: payment.id,
        metadata: { plan, sessionId: session.id, paymentIntentId, subscriptionId },
      })
    }
  })

  console.log(
    `[STRIPE] checkout.session.completed: userId=${userId} → plan=${plan} payment_status=${session.payment_status}`
  )

  // Only send welcome email once payment is confirmed.
  // Bank payment welcome is sent from invoice.paid (subscription_create).
  if (!isPaid) return

  const updated = await profileByUserId(userId)
  if (!updated) return

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
  if (!customerSent) console.error('[STRIPE] Customer receipt email failed for:', updated.email)
  if (EMAIL_CONFIG.adminEmail && !adminSent) console.error('[STRIPE] Admin notification email failed for:', EMAIL_CONFIG.adminEmail)
}

/**
 * invoice.paid
 *
 * Fires for every paid invoice. We act on two billing reasons:
 *
 *   'subscription_create' → bank payment (ACH) that settled 1-4 days after
 *                           checkout. Grant tokens and send welcome email now.
 *   'subscription_cycle'  → monthly renewal. Reset tokens; no email.
 *
 * Card payments are handled in checkout.session.completed and arrive here
 * as subscription_create too — the idempotency guard (stripeLastInvoiceId)
 * prevents a double token grant if both events fire for the same invoice.
 */
async function handleInvoicePaid(invoice: Stripe.Invoice, event: Stripe.Event) {
  const billingReason = invoice.billing_reason
  if (billingReason !== 'subscription_cycle' && billingReason !== 'subscription_create') return

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : null
  if (!customerId) return

  const profile = await profileByCustomer(customerId)
  if (!profile) {
    console.warn('[STRIPE] invoice.paid: no profile for customer', customerId)
    return
  }

  // Idempotency guard: skip if we've already processed this invoice
  if (profile.stripeLastInvoiceId === invoice.id) {
    console.log('[STRIPE] invoice.paid: already processed, skipping', invoice.id)
    return
  }

  const plan = profile.plan ?? 'free'
  const tokenTotal = PLAN_TOKEN_TOTALS[plan]
  if (!tokenTotal) return

  const isInitialPayment = billingReason === 'subscription_create'
  const subscriptionId = invoiceSubscriptionId(invoice)

  // Single transaction: profile update + payment row + ledger credit. This is
  // the actual "money received" event for renewals (subscription_cycle) and
  // for ACH bank payments that settle days after checkout.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(profiles)
      .set({
        tokensTotal: tokenTotal,
        tokensRemaining: tokenTotal,
        subscriptionStatus: 'active',
        stripeLastInvoiceId: invoice.id,
        ...(isInitialPayment && subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profile.id))
      .returning({ tokensRemaining: profiles.tokensRemaining })

    const [payment] = await tx
      .insert(payments)
      .values({
        userId: profile.id,
        provider: 'stripe',
        // Stripe 2026-03-25.dahlia removed invoice.payment_intent. Use the
        // invoice id itself as the provider payment id for renewals — it is
        // unique per billing event and links back to the same Stripe object.
        providerPaymentId: invoice.id ?? null,
        providerCustomerId: customerId,
        providerSessionId: null,
        amountCents: invoice.amount_paid ?? 0,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        status: 'succeeded',
        plan,
        tokensGranted: tokenTotal,
        billingPeriodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
        billingPeriodEnd:   invoice.period_end   ? new Date(invoice.period_end   * 1000) : null,
        invoiceUrl: invoice.hosted_invoice_url ?? null,
        rawEvent: event as unknown as Record<string, unknown>,
      })
      .returning({ id: payments.id })

    await tx.insert(tokenLedger).values({
      userId: profile.id,
      entryType: 'credit',
      endpoint: null,
      agent: null,
      model: null,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: tokenTotal,
      tokensDelta: tokenTotal,
      balanceAfter: updated?.tokensRemaining ?? tokenTotal,
      inputRateUsd: null,
      outputRateUsd: null,
      costInputUsd: null,
      costOutputUsd: null,
      costUsd: null,
      referenceType: 'stripe_payment',
      referenceId: payment.id,
      metadata: { plan, billingReason, invoiceId: invoice.id, subscriptionId },
    })
  })

  console.log(
    `[STRIPE] invoice.paid: userId=${profile.id} plan=${plan} reason=${billingReason}`
  )

  // Welcome email for bank payments only — card payments already emailed from
  // checkout.session.completed. Skip if this profile already has tokens granted
  // (subscription_create for card payments where we already emailed).
  if (!isInitialPayment) return

  // For card payments, checkout.session.completed already sent the email.
  // Only send here if the profile was in pending_payment state (bank/ACH).
  if (profile.subscriptionStatus !== 'pending_payment') return

  const emailPayload = {
    customerEmail: profile.email,
    customerName: profile.fullName ?? undefined,
    plan,
    tokensGranted: tokenTotal,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId ?? profile.stripeSubscriptionId ?? '',
  }

  const [customerSent, adminSent] = await Promise.all([
    sendEmail({ ...buildCustomerEmail(emailPayload), to: profile.email }),
    EMAIL_CONFIG.adminEmail
      ? sendEmail({ ...buildAdminEmail(emailPayload), to: EMAIL_CONFIG.adminEmail })
      : Promise.resolve(false),
  ])
  if (!customerSent) console.error('[STRIPE] Customer receipt email failed for:', profile.email)
  if (EMAIL_CONFIG.adminEmail && !adminSent)
    console.error('[STRIPE] Admin notification email failed for:', EMAIL_CONFIG.adminEmail)
}

/**
 * invoice.created
 *
 * Fires when Stripe drafts a new invoice (before finalization). We use this
 * window to attach a human-readable description and internal metadata so that
 * every invoice the customer receives is clearly labelled.
 *
 * The invoice is only in draft state briefly before finalization — if the
 * update fails (e.g. race condition on the initial checkout invoice), we log
 * and continue rather than failing the webhook.
 */
async function handleInvoiceCreated(invoice: Stripe.Invoice) {
  if (invoice.status !== 'draft') return

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : null
  if (!customerId) return

  const profile = await profileByCustomer(customerId)
  if (!profile) return

  try {
    await getStripe().invoices.update(invoice.id, {
      description: invoiceDescription(profile.plan ?? 'free'),
      metadata: invoiceMetadata(profile.id, profile.plan ?? 'free'),
    })
    console.log(`[STRIPE] invoice.created: customized ${invoice.id} for userId=${profile.id}`)
  } catch (err) {
    // Invoice may already be finalized on initial checkout — not critical
    console.warn(`[STRIPE] invoice.created: could not update ${invoice.id}:`, (err as Error).message)
  }
}

/**
 * invoice.payment_failed
 *
 * Marks the subscription as past_due but does NOT immediately revoke tokens
 * — Stripe will retry and we don't want to punish users for transient failures.
 * Access gating should check subscriptionStatus === 'past_due' to display a
 * warning banner, while tokensRemaining continues to govern hard blocking.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : null
  if (!customerId) return

  const profile = await profileByCustomer(customerId)
  if (!profile) return

  // Verify this is for the user's current subscription (not an old one)
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (subscriptionId && profile.stripeSubscriptionId !== subscriptionId) return

  await db
    .update(profiles)
    .set({ subscriptionStatus: 'past_due', updatedAt: new Date() })
    .where(eq(profiles.id, profile.id))

  console.log(`[STRIPE] invoice.payment_failed: userId=${profile.id} marked past_due`)
}

/**
 * customer.subscription.deleted
 *
 * Fires when a subscription is cancelled (immediately or at period end).
 * IMPORTANT: We check that the deleted subscription ID matches the user's
 * current subscription. If it doesn't, the user has already upgraded to a
 * new subscription and we must not downgrade them.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription, event: Stripe.Event) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : null
  if (!customerId) return

  const profile = await profileByCustomer(customerId)
  if (!profile) return

  // Guard against downgrading a user who already upgraded to a new plan.
  // When upgrading, Stripe cancels the old subscription — if we acted on that
  // deletion, the user would be incorrectly reverted to free.
  if (profile.stripeSubscriptionId !== subscription.id) {
    console.log(
      `[STRIPE] customer.subscription.deleted: subscription ${subscription.id} is not the active one for userId=${profile.id}, skipping`
    )
    return
  }

  // Single transaction: reset profile + record cancellation as a $0 payment row
  // (provenance) + ledger credit reflecting the new free-tier balance.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(profiles)
      .set({
        plan: 'free',
        tokensTotal: PLAN_TOKEN_TOTALS.free,
        tokensRemaining: PLAN_TOKEN_TOTALS.free,
        stripeSubscriptionId: null,
        subscriptionStatus: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profile.id))
      .returning({ tokensRemaining: profiles.tokensRemaining })

    const [payment] = await tx
      .insert(payments)
      .values({
        userId: profile.id,
        provider: 'stripe',
        providerPaymentId: null,
        providerCustomerId: customerId,
        providerSessionId: null,
        amountCents: 0,
        currency: 'usd',
        status: 'refunded',
        plan: 'free',
        tokensGranted: PLAN_TOKEN_TOTALS.free,
        rawEvent: event as unknown as Record<string, unknown>,
      })
      .returning({ id: payments.id })

    await tx.insert(tokenLedger).values({
      userId: profile.id,
      entryType: 'credit',
      endpoint: null,
      agent: null,
      model: null,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: PLAN_TOKEN_TOTALS.free,
      tokensDelta: PLAN_TOKEN_TOTALS.free,
      balanceAfter: updated?.tokensRemaining ?? PLAN_TOKEN_TOTALS.free,
      inputRateUsd: null,
      outputRateUsd: null,
      costInputUsd: null,
      costOutputUsd: null,
      costUsd: null,
      referenceType: 'stripe_payment',
      referenceId: payment.id,
      metadata: { event: 'subscription_cancelled', subscriptionId: subscription.id },
    })
  })

  console.log(`[STRIPE] customer.subscription.deleted: userId=${profile.id} → reverted to free`)
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? ''
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })
  }

  const body = await request.text()
  const sig = request.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  let event: Stripe.Event
  try {
    if (webhookSecret) {
      event = getStripe().webhooks.constructEvent(body, sig, webhookSecret)
    } else {
      // Dev-only bypass: no secret configured, accept unsigned events for local testing
      console.warn('[STRIPE] No STRIPE_WEBHOOK_SECRET — skipping signature verification (dev only)')
      event = JSON.parse(body) as Stripe.Event
    }
  } catch (err) {
    console.error('[STRIPE] Webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event)
        break

      case 'invoice.created':
        await handleInvoiceCreated(event.data.object as Stripe.Invoice)
        break

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice, event)
        break

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event)
        break

      default:
        // Unhandled event types are not an error — Stripe sends many event types
        break
    }
  } catch (err) {
    // Return 500 so Stripe retries the event; do not swallow silently
    console.error(`[STRIPE] Error handling event ${event.type}:`, err)
    return NextResponse.json({ error: 'Webhook handler error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
