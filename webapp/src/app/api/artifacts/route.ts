import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

/**
 * Fetch artifact from Supabase Storage.
 *
 * Vercel serverless has no persistent filesystem across invocations, so we
 * ONLY serve from Supabase Storage. If a run has DB records without a
 * `storageUrl`, it means the MCP never uploaded the artifact — that's a 404.
 * Query params:
 *   testRunId - DB test run ID (auth)
 *   file      - artifact filename or relative path
 *   testName  - disambiguates when multiple tests share a filename
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const testRunId = searchParams.get('testRunId')
  const filePath = searchParams.get('file')
  const testName = searchParams.get('testName')

  if (!testRunId || !filePath) {
    return NextResponse.json({ error: 'Missing testRunId or file' }, { status: 400 })
  }

  const [testRun] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!testRun) {
    return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
  }

  const fileName = filePath.split('/').pop() || filePath

  let artifactType: string | null = null
  if (filePath.includes('/screenshots/') || filePath.includes('screenshot')) {
    artifactType = 'screenshot'
  } else if (filePath.includes('/videos/') || filePath.includes('video')) {
    artifactType = 'video'
  } else if (filePath.includes('/traces/') || filePath.includes('trace')) {
    artifactType = 'trace'
  }

  const conditions = artifactType
    ? and(
        eq(testArtifacts.testRunId, testRunId),
        eq(testArtifacts.fileName, fileName),
        eq(testArtifacts.artifactType, artifactType)
      )
    : and(
        eq(testArtifacts.testRunId, testRunId),
        eq(testArtifacts.fileName, fileName)
      )

  const matches = await db
    .select({
      id: testArtifacts.id,
      testName: testArtifacts.testName,
      storageUrl: testArtifacts.storageUrl,
      fileName: testArtifacts.fileName,
      contentType: testArtifacts.contentType,
    })
    .from(testArtifacts)
    .where(conditions)

  let artifact = null
  if (matches.length === 1) {
    artifact = matches[0]
  } else if (matches.length > 1) {
    artifact = matches.find(a => a.testName === testName)
      ?? matches.find(a => a.testName?.toLowerCase() === testName?.toLowerCase())
      ?? matches[0]
  }

  if (!artifact) {
    return NextResponse.json(
      { error: 'Artifact not found', fileName },
      { status: 404 }
    )
  }

  if (!artifact.storageUrl) {
    return NextResponse.json(
      {
        error: 'Artifact not uploaded to Supabase Storage',
        fileName,
        hint: 'This run was recorded before artifact upload was configured, or the MCP failed to upload.',
      },
      { status: 404 }
    )
  }

  return NextResponse.redirect(artifact.storageUrl, 307)
}
