import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { extractRunIdFromReport, getLiveRunsForUser } from '@/lib/mcp-live-runs'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    if (id.startsWith('live-')) {
      const runId = id.slice('live-'.length).trim()
      if (!runId) {
        return NextResponse.json({ error: 'Invalid live run id' }, { status: 400 })
      }

      // Prefer a real ingested run when it exists — ingest happens during the
      // 'reporting' phase, well before 'completed', so this fires as soon as
      // results are available and returns full report_json + ai_analysis.
      const [ingestedRow] = await db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.userId, user.id),
            sql`${testRuns.reportJson}->'metadata'->>'runId' = ${runId}`
          )
        )
        .orderBy(testRuns.createdAt)
        .limit(1)

      if (ingestedRow) {
        const data = {
          id: ingestedRow.id,
          user_id: ingestedRow.userId,
          creation_name: ingestedRow.creationName,
          status: ingestedRow.status,
          total_tests: ingestedRow.totalTests,
          passed_tests: ingestedRow.passedTests,
          failed_tests: ingestedRow.failedTests,
          skipped_tests: ingestedRow.skippedTests,
          backend_pass_rate: ingestedRow.backendPassRate ? Number(ingestedRow.backendPassRate) : null,
          frontend_pass_rate: ingestedRow.frontendPassRate ? Number(ingestedRow.frontendPassRate) : null,
          duration_ms: ingestedRow.durationMs,
          report_json: ingestedRow.reportJson,
          ai_analysis: ingestedRow.aiAnalysis,
          framework: ingestedRow.framework,
          source: ingestedRow.source,
          created_at: ingestedRow.createdAt?.toISOString() ?? null,
          updated_at: ingestedRow.updatedAt?.toISOString() ?? null,
          run_id: extractRunIdFromReport(ingestedRow.reportJson),
          current_phase: null,
          error_code: null,
          is_live: false,
        }
        return NextResponse.json({ data })
      }

      // Fall back to synthetic live data while the run is still in progress
      const [liveRun] = await getLiveRunsForUser(user.id, { runId, windowHours: 72, limit: 1500 })
      if (!liveRun) {
        return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
      }

      return NextResponse.json({ data: liveRun })
    }

    const [row] = await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, user.id)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
    }

    const data = {
      id: row.id,
      user_id: row.userId,
      creation_name: row.creationName,
      status: row.status,
      total_tests: row.totalTests,
      passed_tests: row.passedTests,
      failed_tests: row.failedTests,
      skipped_tests: row.skippedTests,
      backend_pass_rate: row.backendPassRate ? Number(row.backendPassRate) : null,
      frontend_pass_rate: row.frontendPassRate ? Number(row.frontendPassRate) : null,
      duration_ms: row.durationMs,
      report_json: row.reportJson,
      ai_analysis: row.aiAnalysis,
      framework: row.framework,
      source: row.source,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
      run_id: extractRunIdFromReport(row.reportJson),
      current_phase: null,
      error_code: null,
      is_live: false,
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[Test Run] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test run' }, { status: 500 })
  }
}
