import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { logBlockedRequest } from '@/lib/security-logger'
import type { ExplorationArtifact, ParsedPRD } from '@/lib/test-generation/types'

const ENDPOINT = '/api/exploration/plan'

// Lightweight, deterministic planner. We intentionally DO NOT spend a token on
// this — the exploration artifact + parsedPRD already carry enough signal for
// a rule-based prioritisation.
// If a run needs LLM-grade prioritisation later, flip HEALIX_PLANNER_AGENT=1
// and replace this with a function-call to OpenAI.

type PlannedFlow = {
  name: string
  tier: 'A-public' | 'B-auth' | 'C-backend'
  reason: string
  priority: number
}

type SuggestedAC = {
  id: string
  text: string
  authRequired: boolean
  source: 'exploration'
}

function planFlows(artifact: ExplorationArtifact, parsedPRD: ParsedPRD | null): PlannedFlow[] {
  const plans: PlannedFlow[] = []

  for (const route of artifact.routes || []) {
    plans.push({
      name: `route:${route.path}`,
      tier: route.requiresAuth ? 'B-auth' : 'A-public',
      reason: route.requiresAuth ? 'observed auth-gated route' : 'observed public route',
      priority: route.requiresAuth ? 60 : 40,
    })
  }

  for (const flow of artifact.keyFlows || []) {
    plans.push({
      name: `flow:${flow.name}`,
      tier: 'B-auth',
      reason: 'observed key user flow',
      priority: 80,
    })
  }

  if (artifact.authFlow) {
    plans.push({
      name: 'auth:login',
      tier: 'B-auth',
      reason: 'observed login form — gate for Tier B',
      priority: 100,
    })
  }

  // Backend-only flows inferred from parsed AC marked authRequired: true with no UI page.
  if (parsedPRD?.features?.length) {
    for (const feature of parsedPRD.features) {
      for (const story of feature.userStories || []) {
        for (const ac of story.acceptanceCriteria || []) {
          plans.push({
            name: `ac:${ac.id}`,
            tier: ac.authRequired ? 'B-auth' : 'A-public',
            reason: `PRD AC ${ac.id}`,
            priority: ac.kind === 'negative' ? 70 : 50,
          })
        }
      }
    }
  }

  return plans.sort((a, b) => b.priority - a.priority)
}

function suggestACFromExploration(artifact: ExplorationArtifact): SuggestedAC[] {
  const suggested: SuggestedAC[] = []
  let counter = 1
  for (const flow of artifact.keyFlows || []) {
    suggested.push({
      id: `EXP.AC${counter++}`,
      text: `${flow.name} reaches "${flow.endCondition}"`,
      authRequired: true,
      source: 'exploration',
    })
  }
  for (const form of artifact.forms || []) {
    suggested.push({
      id: `EXP.AC${counter++}`,
      text: `Form at ${form.route} submits with label "${form.submitLabel}"`,
      authRequired: false,
      source: 'exploration',
    })
  }
  return suggested
}

export async function POST(request: NextRequest) {
  try {
    const rawKey = request.headers.get('x-api-key') ?? null
    const body = await request.json()
    const finalApiKey: string = rawKey ?? body?.api_key ?? ''

    if (!finalApiKey) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    const explorationArtifact = body?.explorationArtifact as ExplorationArtifact | null | undefined
    const parsedPRD = (body?.parsedPRD || null) as ParsedPRD | null

    if (!explorationArtifact) {
      return NextResponse.json({ error: 'Missing explorationArtifact' }, { status: 422 })
    }

    const keyHash = hashApiKey(finalApiKey)
    const [record] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, revoked: apiKeys.revoked, isActive: apiKeys.isActive })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!record || record.revoked) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const flows = planFlows(explorationArtifact, parsedPRD)
    const suggestedAcceptanceCriteria = suggestACFromExploration(explorationArtifact)

    return NextResponse.json({
      success: true,
      flows,
      suggestedAcceptanceCriteria,
      counts: {
        flows: flows.length,
        suggestedAC: suggestedAcceptanceCriteria.length,
      },
    })
  } catch (error) {
    console.error('[exploration/plan] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
