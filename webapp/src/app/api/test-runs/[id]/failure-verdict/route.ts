/**
 * POST /api/test-runs/[id]/failure-verdict
 *
 * Phase T5 — human override endpoint for a failure's verdict. The dashboard
 * offers three buttons (Test wrong / App wrong / Flake) per failed test row
 * and POSTs here when the user clicks one. The override becomes a training
 * label: it both updates the dashboard immediately AND is read by training
 * pipelines that tune prompt/rule weights.
 *
 * Rate-limited + auth-gated (user must own the test_run). We never delete a
 * classifier/AI verdict — user_override sits alongside them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testFailures, testRuns } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/rate-limit'

const ENDPOINT = '/api/test-runs/[id]/failure-verdict'

const ALLOWED_OVERRIDES = new Set(['test_is_wrong', 'app_is_wrong', 'environment', 'flake'])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const rate = await checkRateLimit({ keyHash: user.id, userId: user.id, endpoint: ENDPOINT })
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 1) } }
      )
    }

    const { id: runId } = await params
    if (!runId) return NextResponse.json({ error: 'Missing run id' }, { status: 400 })

    const body = await request.json().catch(() => null)
    const failureId = typeof body?.failureId === 'string' ? body.failureId : null
    const override = typeof body?.override === 'string' ? body.override : null

    if (!failureId || !override || !ALLOWED_OVERRIDES.has(override)) {
      return NextResponse.json(
        { error: 'Body requires { failureId, override } with override in test_is_wrong|app_is_wrong|environment|flake' },
        { status: 400 }
      )
    }

    // Verify the user owns the run this failure is attached to. We join on
    // (test_run_id, user_id) so an attacker cannot override someone else's
    // failure even with a guessed failureId.
    const [run] = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(and(eq(testRuns.id, runId), eq(testRuns.userId, user.id)))
      .limit(1)
    if (!run) return NextResponse.json({ error: 'Run not found or not owned by you' }, { status: 404 })

    const [existing] = await db
      .select({ id: testFailures.id })
      .from(testFailures)
      .where(and(
        eq(testFailures.id, failureId),
        eq(testFailures.testRunId, runId),
        eq(testFailures.userId, user.id),
      ))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Failure not found or not owned by you' }, { status: 404 })
    }

    await db
      .update(testFailures)
      .set({ userOverride: override, userOverrideAt: new Date() })
      .where(eq(testFailures.id, failureId))

    return NextResponse.json({ success: true, failureId, override })
  } catch (err) {
    console.error('[failure-verdict] error', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
