'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Profile } from '@/lib/types/database'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 'Free',
    priceNote: 'forever',
    description: 'Start free. No credit card required.',
    tokens: 240_000,
    tokenLabel: '50 tokens / month',
    features: ['1 user · 1 project', 'Basic AI models', 'Basic test types', 'Community support'],
    cta: 'Current Plan',
    highlighted: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$15',
    priceNote: '/month',
    description: 'Advanced AI for growing teams.',
    tokens: 2_400_000,
    tokenLabel: '500 tokens / month',
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
    tokens: 4_800_000,
    tokenLabel: '1,000 tokens / month',
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
    tokenLabel: 'Unlimited tokens',
    features: [
      'Custom AI model selection',
      'API access + custom agents',
      'Dedicated CSM + 99.9% SLA',
      'SSO/SAML + compliance',
    ],
    cta: 'Contact Sales',
    highlighted: false,
  },
] as const

// 1 displayed unit = 4,800 real OpenAI tokens → Starter (2.4M) shows 500, Team (4.8M) shows 1,000
const REAL_TOKENS_PER_UNIT = 4_800

function toDisplayUnits(realTokens: number): number {
  return Math.floor(realTokens / REAL_TOKENS_PER_UNIT)
}

function TokenMeter({ remaining, total }: { remaining: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0
  const color = pct > 50 ? '#3B82F6' : pct > 20 ? '#F59E0B' : '#EF4444'

  return (
    <div>
      <div className="flex justify-between text-sm mb-2">
        <span className="text-text-secondary">Tokens remaining</span>
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

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/profile')
        if (!res.ok) return
        const { data } = await res.json()
        if (data) setProfile(data)
      } catch (err) {
        console.error('Failed to load profile:', err)
      }
      setLoading(false)
    }
    load()
  }, [])

  const currentPlan = profile?.plan ?? 'free'

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
                    <h2 className="text-xl font-bold text-text-primary capitalize">{currentPlan}</h2>
                    <Badge variant={currentPlan === 'enterprise' ? 'info' : currentPlan === 'team' || currentPlan === 'starter' ? 'success' : 'neutral'}>
                      Active
                    </Badge>
                  </div>
                </div>
                {currentPlan !== 'enterprise' && (
                  <Button variant="secondary" size="sm">
                    Manage Billing
                  </Button>
                )}
              </div>
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
            return (
              <Card
                key={plan.id}
                delay={0.15 + i * 0.1}
                gradient={plan.highlighted}
                className={`p-6 flex flex-col ${plan.highlighted ? 'border-blue-500/30 shadow-[0_0_40px_rgba(59,130,246,0.15)]' : ''}`}
              >
                {plan.highlighted && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2">
                    <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gradient-to-r from-blue-500 to-cyan-400 text-white shadow-lg">
                      Most Popular
                    </span>
                  </div>
                )}

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
                  disabled={isCurrent}
                >
                  {isCurrent ? 'Current Plan' : plan.cta}
                </Button>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
