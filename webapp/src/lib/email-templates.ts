import { PLAN_DISPLAY_NAMES, PLAN_DESCRIPTIONS } from './stripe-invoice'

// ---------------------------------------------------------------------------
// Shared styles — inline so email clients render them correctly
// ---------------------------------------------------------------------------

const BASE_STYLES = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0a0a0a;
  color: #e0e0e0;
  margin: 0;
  padding: 0;
`

const CONTAINER = `
  max-width: 560px;
  margin: 40px auto;
  background: #111;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  overflow: hidden;
`

const HEADER = `
  background: linear-gradient(135deg, #1a1a2e 0%, #0d1b2a 100%);
  padding: 32px 40px;
  border-bottom: 1px solid #2a2a2a;
`

const BODY = `padding: 32px 40px;`

const FOOTER = `
  padding: 24px 40px;
  border-top: 1px solid #1a1a1a;
  text-align: center;
`

// ---------------------------------------------------------------------------
// Customer welcome email
// Sent to the subscriber after a successful checkout.
// ---------------------------------------------------------------------------

export interface CustomerEmailData {
  customerEmail: string
  customerName?: string
  plan: string
  tokensGranted: number
}

export function buildCustomerEmail(data: CustomerEmailData): { subject: string; html: string } {
  const planLabel = PLAN_DISPLAY_NAMES[data.plan] ?? data.plan
  const planDescription = PLAN_DESCRIPTIONS[data.plan] ?? ''
  const displayCredits = Math.round(data.tokensGranted / 4800).toLocaleString()
  const greeting = data.customerName ? `Hi ${data.customerName}` : 'Hi there'

  const subject = `Welcome to Healix ${planLabel} — you're all set`

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${BASE_STYLES}">
  <div style="${CONTAINER}">

    <!-- Header -->
    <div style="${HEADER}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <div style="width:36px;height:36px;background:linear-gradient(135deg,#3b82f6,#06b6d4);border-radius:8px;display:flex;align-items:center;justify-content:center;">
          <span style="color:white;font-weight:900;font-size:16px;">H</span>
        </div>
        <span style="color:#f0f6ff;font-weight:700;font-size:18px;letter-spacing:-0.3px;">Healix</span>
      </div>
      <h1 style="margin:0;color:#f0f6ff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">
        You're on the ${planLabel} plan
      </h1>
      <p style="margin:8px 0 0;color:#8ba4c8;font-size:14px;">${planDescription}</p>
    </div>

    <!-- Body -->
    <div style="${BODY}">
      <p style="margin:0 0 24px;color:#c0cfe0;font-size:15px;line-height:1.6;">
        ${greeting},<br><br>
        Your subscription is active. Here's what's ready for you right now.
      </p>

      <!-- Credits box -->
      <div style="background:#0d1f0d;border:1px solid #1a3a1a;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
        <div style="color:#4ade80;font-size:28px;font-weight:800;letter-spacing:-0.5px;">${displayCredits} credits</div>
        <div style="color:#6b9e6b;font-size:13px;margin-top:4px;">added to your account · resets monthly</div>
      </div>

      <!-- What's included -->
      <p style="margin:0 0 12px;color:#8ba4c8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;">What's included</p>
      <ul style="margin:0 0 28px;padding:0;list-style:none;">
        ${getPlanFeatures(data.plan).map(f => `
        <li style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #1a1a1a;color:#c0cfe0;font-size:14px;">
          <span style="color:#3b82f6;font-weight:700;flex-shrink:0;">✓</span>${f}
        </li>`).join('')}
      </ul>

      <!-- CTA -->
      <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://healix.ai'}/home"
         style="display:block;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:white;text-decoration:none;font-weight:700;font-size:14px;padding:14px 24px;border-radius:6px;text-align:center;letter-spacing:0.2px;">
        Go to Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="${FOOTER}">
      <p style="margin:0;color:#3a3a3a;font-size:12px;line-height:1.6;">
        You're receiving this because you subscribed to Healix.<br>
        Questions? Reply to this email or contact us at
        <a href="mailto:support@healix.ai" style="color:#3b82f6;text-decoration:none;">support@healix.ai</a>
      </p>
    </div>

  </div>
</body>
</html>`

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Admin notification email
// Sent to the internal team when a new subscriber completes checkout.
// ---------------------------------------------------------------------------

export interface AdminEmailData {
  customerEmail: string
  customerName?: string
  plan: string
  tokensGranted: number
  stripeCustomerId: string
  stripeSubscriptionId: string
}

export function buildAdminEmail(data: AdminEmailData): { subject: string; html: string } {
  const planLabel = PLAN_DISPLAY_NAMES[data.plan] ?? data.plan
  const now = new Date().toUTCString()

  const subject = `[Healix] New subscriber — ${planLabel} · ${data.customerEmail}`

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="${BASE_STYLES}">
  <div style="${CONTAINER}">

    <div style="${HEADER}">
      <p style="margin:0 0 6px;color:#4ade80;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">New Subscriber</p>
      <h1 style="margin:0;color:#f0f6ff;font-size:22px;font-weight:800;">${planLabel} Plan</h1>
      <p style="margin:6px 0 0;color:#8ba4c8;font-size:13px;">${now}</p>
    </div>

    <div style="${BODY}">

      <!-- Details table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${row('Customer', data.customerEmail)}
        ${row('Name', data.customerName ?? '—')}
        ${row('Plan', planLabel)}
        ${row('Credits granted', Math.round(data.tokensGranted / 4800).toLocaleString())}
        ${row('Stripe customer', data.stripeCustomerId)}
        ${row('Stripe subscription', data.stripeSubscriptionId)}
      </table>

      <!-- Stripe Dashboard link -->
      <a href="https://dashboard.stripe.com/customers/${data.stripeCustomerId}"
         style="display:inline-block;background:#635bff;color:white;text-decoration:none;font-weight:600;font-size:13px;padding:10px 20px;border-radius:5px;">
        View in Stripe Dashboard →
      </a>

    </div>

  </div>
</body>
</html>`

  return { subject, html }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:10px 0;color:#8ba4c8;font-size:13px;border-bottom:1px solid #1a1a1a;width:40%;vertical-align:top;">${label}</td>
      <td style="padding:10px 0;color:#e0e0e0;font-size:13px;border-bottom:1px solid #1a1a1a;font-family:monospace;">${value}</td>
    </tr>`
}

function getPlanFeatures(plan: string): string[] {
  const features: Record<string, string[]> = {
    starter: [
      'Advanced AI models (gpt-5.5-mini)',
      'All test types + self-healing',
      'Jira / ADO integration',
      'Priority support',
    ],
    team: [
      'Advanced models + priority queue',
      'Custom integrations (10 hrs onboarding)',
      'CI/CD pipeline integration',
      'Priority support (< 4hr SLA)',
    ],
    enterprise: [
      'Custom AI model selection',
      'API access + custom agents',
      'Dedicated CSM + 99.9% SLA',
      'SSO/SAML + compliance',
    ],
  }
  return features[plan] ?? ['Access to Healix platform']
}
