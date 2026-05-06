'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { Profile } from '@/lib/types/database'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import { toDisplayUnits } from '@/lib/token-units'

type PlanId = 'free' | 'starter' | 'team' | 'enterprise'

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, team: 2, enterprise: 3 }

const PLANS: {
  id: PlanId
  name: string
  price: string
  priceNote: string
  description: string
  tokens: number
  tokenLabel: string
  features: string[]
  cta: string
  ctaHref?: string
  highlighted: boolean
}[] = [
  {
    id: 'free',
    name: 'Trial',
    price: 'Free',
    priceNote: 'forever',
    description: 'Start free. No credit card required.',
    tokens: 240_000,
    tokenLabel: '500 credits / month',
    features: ['1 user · 1 project', 'Basic AI models', 'Basic test types', 'Community support'],
    cta: 'Downgrade to Trial',
    highlighted: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$15',
    priceNote: '/month',
    description: 'Advanced AI for growing teams.',
    tokens: 12_000_000,
    tokenLabel: '2,500 credits / month',
    features: ['Advanced AI models', 'All test types · self healing', 'Jira / ADO integration', 'Priority support'],
    cta: 'Upgrade to Starter',
    highlighted: false,
  },
  {
    id: 'team',
    name: 'Team',
    price: '$30',
    priceNote: '/month',
    description: 'Scalable testing for engineering teams.',
    tokens: 48_000_000,
    tokenLabel: '10,000 credits / month',
    features: [
      'Advanced models + priority queue',
      'Custom integrations (10 hrs onboarding)',
      'CI/CD pipeline integration',
      'Priority support (< 4hr SLA)',
    ],
    cta: 'Upgrade to Team',
    highlighted: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    priceNote: '',
    description: 'Custom AI, dedicated infrastructure, and SLA.',
    tokens: Infinity,
    tokenLabel: 'Unlimited credits',
    features: [
      'Custom AI model selection',
      'API access + custom agents',
      'Dedicated CSM + 99.9% SLA',
      'SSO/SAML + compliance',
    ],
    cta: 'Contact Sales',
    ctaHref: 'mailto:Swathi.Dharshna@zapcg.com',
    highlighted: false,
  },
]

// Display ratio + toDisplayUnits imported from @/lib/tokens so the billing
// page, the sidebar, and the home plan card all derive from the same source.

function TokenMeter({ remaining, total }: { remaining: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0
  const color = pct > 50 ? '#3B82F6' : pct > 20 ? '#F59E0B' : '#EF4444'

  return (
    <div>
      <div className="flex justify-between text-sm mb-2">
        <span className="text-text-secondary">Credits remaining</span>
        <span className="text-text-primary font-semibold">
          {toDisplayUnits(remaining).toLocaleString()} / {toDisplayUnits(total).toLocaleString()}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-white/8 overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
          className="h-full rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}60` }}
        />
      </div>
      <p className="text-text-muted text-xs mt-1.5">{Math.round(pct)}% remaining this cycle</p>
    </div>
  )
}

export default function PlanBillingPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [checkingOut, setCheckingOut] = useState<PlanId | null>(null)
  const [openingPortal, setOpeningPortal] = useState(false)
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'cancelled'; message: string } | null>(null)
  const [downgradeTarget, setDowngradeTarget] = useState<typeof PLANS[number] | null>(null)

  const searchParams = useSearchParams()
  const router = useRouter()

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/profile')
      if (!res.ok) return
      const { data } = await res.json()
      if (data) setProfile(data)
    } catch (err) {
      console.error('Failed to load profile:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  useEffect(() => {
    const payment = searchParams.get('payment')
    const plan = searchParams.get('plan')
    const sessionId = searchParams.get('session_id')
    if (payment === 'success' && plan) {
      setBanner({ type: 'success', message: `You're now on the ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan! Your credits have been refreshed.` })
      const confirmAndRefresh = async () => {
        if (sessionId) {
          try {
            await fetch('/api/stripe/checkout/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
          } catch { /* best-effort — loadProfile will still refresh the UI */ }
        }
        await loadProfile()
        window.dispatchEvent(new Event('healix:profile-updated'))
        // Clean up URL only after profile is refreshed so the effect cleanup
        // does not cancel loadProfile() mid-flight (router.replace changes
        // searchParams, which re-runs this effect and sets alive=false).
        router.replace('/plan-billing')
      }
      void confirmAndRefresh()
    } else if (payment === 'cancelled') {
      setBanner({ type: 'cancelled', message: 'Payment was cancelled. Your plan has not changed.' })
      router.replace('/plan-billing')
    }
  }, [searchParams, router, loadProfile])

  const currentPlan: PlanId = (profile?.plan as PlanId) ?? 'free'

  const handlePlanAction = (plan: typeof PLANS[number]) => {
    if (plan.id === currentPlan) return
    if (plan.ctaHref) {
      window.location.href = plan.ctaHref
      return
    }

    const targetRank = PLAN_RANK[plan.id]
    const currentRank = PLAN_RANK[currentPlan]

    if (targetRank < currentRank) {
      setDowngradeTarget(plan)
      return
    }

    void executeUpgrade(plan)
  }

  const executeDowngrade = async () => {
    if (!downgradeTarget) return
    const plan = downgradeTarget
    setDowngradeTarget(null)
    setCheckingOut(plan.id)
    setBanner(null)
    try {
      const res = await fetch('/api/profile/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setBanner({ type: 'error', message: error ?? 'Downgrade failed. Please try again.' })
        return
      }
      await loadProfile()
      window.dispatchEvent(new Event('healix:profile-updated'))
      setBanner({ type: 'success', message: `Downgraded to ${plan.name}. Your remaining credits are preserved.` })
    } catch {
      setBanner({ type: 'error', message: 'An unexpected error occurred. Please try again.' })
    } finally {
      setCheckingOut(null)
    }
  }

  const openPortal = async () => {
    setOpeningPortal(true)
    setBanner(null)
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' })
      if (!res.ok) {
        const { error } = await res.json()
        setBanner({ type: 'error', message: error ?? 'Could not open billing portal.' })
        return
      }
      const { url } = await res.json()
      window.location.href = url
    } catch {
      setBanner({ type: 'error', message: 'An unexpected error occurred. Please try again.' })
    } finally {
      setOpeningPortal(false)
    }
  }

  const executeUpgrade = async (plan: typeof PLANS[number]) => {
    setCheckingOut(plan.id)
    setBanner(null)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setBanner({ type: 'error', message: error ?? 'Could not start checkout. Please try again.' })
        return
      }
      const { url } = await res.json()
      window.location.href = url
    } catch {
      setBanner({ type: 'error', message: 'An unexpected error occurred. Please try again.' })
    } finally {
      setCheckingOut(null)
    }
  }

  return (
    <div className="min-h-screen bg-bg-darkest p-6">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-2xl font-bold text-text-primary mb-1">Plan & Billing</h1>
          <p className="text-text-muted text-sm mb-8">Manage your subscription and token usage</p>
        </motion.div>

        <AnimatePresence>
          {banner && (
            <motion.div
              key="banner"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className={`flex items-center justify-between gap-4 px-4 py-3 rounded-none border-2 mb-6 text-sm font-medium ${
                banner.type === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : banner.type === 'cancelled'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
              }`}
            >
              <span>{banner.message}</span>
              <button onClick={() => setBanner(null)} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">✕</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Current plan summary */}
        <Card delay={0.1} gradient className="p-6 mb-8">
          {loading ? (
            <div className="flex flex-col gap-3">
              <div className="shimmer h-6 w-32 rounded-lg" />
              <div className="shimmer h-3 w-full rounded-lg" />
              <div className="shimmer h-3 w-3/4 rounded-lg" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-muted text-sm mb-1">Current plan</p>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-text-primary capitalize">{currentPlan === 'free' ? 'Trial' : currentPlan}</h2>
                    <Badge
                      variant={
                        profile?.subscription_status === 'past_due'
                          ? 'warning'
                          : profile?.subscription_status === 'cancelled'
                          ? 'neutral'
                          : currentPlan === 'enterprise'
                          ? 'info'
                          : currentPlan === 'team' || currentPlan === 'starter'
                          ? 'success'
                          : 'neutral'
                      }
                    >
                      {profile?.subscription_status === 'past_due'
                        ? 'Past Due'
                        : profile?.subscription_status === 'cancelled'
                        ? 'Cancelled'
                        : 'Active'}
                    </Badge>
                  </div>
                </div>
                {profile?.stripe_customer_id && currentPlan !== 'free' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={openingPortal}
                    disabled={openingPortal}
                    onClick={openPortal}
                  >
                    Manage Billing
                  </Button>
                )}
              </div>
              {profile?.subscription_status === 'past_due' && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-none border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  Payment failed. Please update your payment method to avoid service interruption.
                </div>
              )}
              <TokenMeter
                remaining={profile?.tokens_remaining ?? 0}
                total={profile?.tokens_total ?? 1_000_000}
              />
            </div>
          )}
        </Card>

        {/* Plan comparison */}
        <h2 className="text-lg font-semibold text-text-primary mb-4">Available Plans</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLANS.map((plan, i) => {
            const isCurrent = plan.id === currentPlan
            const isLoading = checkingOut === plan.id
            const isAnyLoading = checkingOut !== null
            return (
              <Card
                key={plan.id}
                delay={0.15 + i * 0.1}
                gradient={plan.highlighted}
                className={`p-6 flex flex-col ${plan.highlighted ? 'border-blue-500/30 shadow-[0_0_40px_rgba(59,130,246,0.15)]' : ''}`}
              >

                <div className="mb-5">
                  <h3 className="text-text-primary font-semibold text-base mb-1">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="text-3xl font-bold text-text-primary">{plan.price}</span>
                    {plan.priceNote && (
                      <span className="text-text-muted text-sm">{plan.priceNote}</span>
                    )}
                  </div>
                  <p className="text-text-muted text-xs mb-1.5">{plan.description}</p>
                  <span className="inline-block text-xs font-medium text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded-full">{plan.tokenLabel}</span>
                </div>

                <ul className="flex flex-col gap-2.5 flex-1 mb-6">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-text-secondary">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 shrink-0 text-blue-400">
                        <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={isCurrent ? 'secondary' : plan.highlighted ? 'primary' : 'secondary'}
                  size="md"
                  className="w-full"
                  disabled={isCurrent || isAnyLoading}
                  loading={isLoading}
                  onClick={() => handlePlanAction(plan)}
                >
                  {isCurrent ? 'Current Plan' : plan.cta}
                </Button>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Downgrade confirmation modal */}
      <AnimatePresence>
        {downgradeTarget && (
          <motion.div
            key="downgrade-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            onClick={() => setDowngradeTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 12 }}
              transition={{ duration: 0.2 }}
              className="bg-[#111111] border-2 border-[#333333] shadow-[6px_6px_0px_#555555] w-full max-w-md p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3 mb-5">
                <div className="mt-0.5 shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-amber-500/15 border border-amber-500/30">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-text-primary font-bold text-base mb-1">Downgrade to {downgradeTarget.name}?</h3>
                  <p className="text-text-muted text-sm leading-relaxed">
                    You will lose access to{' '}
                    <span className="text-text-secondary font-medium capitalize">{currentPlan}</span> features immediately.
                    Your remaining credit balance will be preserved — you can continue using it on the Trial plan.
                  </p>
                </div>
              </div>

              <div className="bg-white/5 border border-white/10 px-4 py-3 mb-6 text-xs text-text-muted space-y-1">
                <p>✓ Your remaining credits are <span className="text-emerald-400 font-medium">kept</span> — they won't be wiped.</p>
                <p>✗ AI model access reverts to <span className="text-amber-400 font-medium">Basic</span> tier immediately.</p>
                <p>✗ Jira/ADO integrations and priority support are <span className="text-red-400 font-medium">disabled</span>.</p>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  size="md"
                  className="flex-1"
                  onClick={() => setDowngradeTarget(null)}
                >
                  Keep Current Plan
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  className="flex-1 !bg-amber-500 !border-amber-600 !text-black hover:!bg-amber-400"
                  onClick={executeDowngrade}
                >
                  Yes, Downgrade
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
