import { Resend } from 'resend'

// ---------------------------------------------------------------------------
// Config — all values come from env vars so they can be changed without
// touching code. Update them in .env.local (dev) or your hosting dashboard.
// ---------------------------------------------------------------------------

export const EMAIL_CONFIG = {
  /** The "From" address on every outgoing email. Must be a verified domain in Resend. */
  from: process.env.FROM_EMAIL ?? 'Healix <onboarding@resend.dev>',

  /** Internal email that receives admin notifications (new subscriber, etc.). */
  adminEmail: process.env.ADMIN_NOTIFICATION_EMAIL ?? '',
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let _resend: Resend | null = null

function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) throw new Error('RESEND_API_KEY is not configured')
    _resend = new Resend(key)
  }
  return _resend
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

interface SendOptions {
  to: string
  subject: string
  html: string
}

/**
 * Send a single email. Returns true on success, false on failure.
 * Never throws — email failures must not break the webhook response.
 */
export async function sendEmail(opts: SendOptions): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    // Dev: log instead of send when no API key is configured
    console.log('[EMAIL] No RESEND_API_KEY — would have sent:')
    console.log(`  To:      ${opts.to}`)
    console.log(`  Subject: ${opts.subject}`)
    return true
  }

  try {
    const { error } = await getResend().emails.send({
      from: EMAIL_CONFIG.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    })

    if (error) {
      console.error('[EMAIL] Send failed:', error)
      return false
    }

    console.log(`[EMAIL] Sent "${opts.subject}" → ${opts.to}`)
    return true
  } catch (err) {
    console.error('[EMAIL] Unexpected error:', err)
    return false
  }
}
