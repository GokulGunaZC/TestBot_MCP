import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

/**
 * Fetch artifact signed URL from test_artifacts table ONLY
 * NO local filesystem fallback - artifacts must be in Supabase Storage
 * 
 * Query params:
 *   testRunId  - the DB test run ID (for auth)
 *   file       - artifact file name or path to match
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const testRunId = searchParams.get('testRunId')
  const filePath = searchParams.get('file')

  if (!testRunId || !filePath) {
    return NextResponse.json({ error: 'Missing testRunId or file' }, { status: 400 })
  }

  // Verify user owns this test run
  const [testRun] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!testRun) {
    return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
  }

  // Extract filename from path
  const fileName = filePath.split('/').pop() || filePath

  // Query test_artifacts table for matching artifact
  const artifacts = await db
    .select({
      id: testArtifacts.id,
      storageUrl: testArtifacts.storageUrl,
      storagePath: testArtifacts.storagePath,
      fileName: testArtifacts.fileName,
      contentType: testArtifacts.contentType,
    })
    .from(testArtifacts)
    .where(
      and(
        eq(testArtifacts.testRunId, testRunId),
        eq(testArtifacts.fileName, fileName)
      )
    )
    .limit(1)

  if (!artifacts || artifacts.length === 0) {
    return NextResponse.json(
      {
        error: 'Artifact not found in storage',
        fileName,
        hint: 'Artifacts are only available if they were uploaded to Supabase Storage. Local files are not served.',
      },
      { status: 404 }
    )
  }

  const artifact = artifacts[0]

  // Return redirect to signed URL (Supabase handles auth and streaming)
  return NextResponse.redirect(artifact.storageUrl, 307)
}
