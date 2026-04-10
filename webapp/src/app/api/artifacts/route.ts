import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'

/**
 * Search for artifact file in local filesystem
 * Artifacts are stored in: {projectPath}/healix-reports/artifacts/
 */
function searchLocalArtifact(fileName: string, projectPath: string | null): string | null {
  if (!projectPath) {
    console.warn(`[artifacts] No project path available for artifact search`)
    return null
  }

  // Artifacts are copied to healix-reports/artifacts/ during report generation
  const artifactsBaseDir = path.join(projectPath, 'healix-reports', 'artifacts')

  console.log(`[artifacts] Searching for ${fileName} in ${artifactsBaseDir}...`)

  if (!fs.existsSync(artifactsBaseDir)) {
    console.warn(`[artifacts] Artifacts directory does not exist: ${artifactsBaseDir}`)
    return null
  }

  try {
    // Recursively search the artifacts directory
    const found = searchDirectory(artifactsBaseDir, fileName)
    if (found) {
      console.log(`[artifacts] Found artifact at: ${found}`)
      return found
    }
  } catch (error) {
    console.warn(`[artifacts] Error searching ${artifactsBaseDir}:`, error)
  }

  console.warn(`[artifacts] Artifact ${fileName} not found in ${artifactsBaseDir}`)
  return null
}

/**
 * Recursively search directory for a file
 */
function searchDirectory(dir: string, targetFileName: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // Recursively search subdirectories
      const found = searchDirectory(fullPath, targetFileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === targetFileName) {
      return fullPath
    }
  }

  return null
}

/**
 * Fetch artifact from Supabase Storage or local filesystem fallback
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
  const testName = searchParams.get('testName') // Used to disambiguate when multiple tests share the same filename

  if (!testRunId || !filePath) {
    return NextResponse.json({ error: 'Missing testRunId or file' }, { status: 400 })
  }

  // Verify user owns this test run and get project path
  const [testRun] = await db
    .select({ id: testRuns.id, projectPath: testRuns.projectPath })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!testRun) {
    return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
  }

  // Extract filename from path (e.g., "artifacts/screenshots/foo.png" → "foo.png")
  const fileName = filePath.split('/').pop() || filePath

  // Infer artifact type from path (e.g., "artifacts/screenshots/..." → "screenshot")
  let artifactType: string | null = null
  if (filePath.includes('/screenshots/') || filePath.includes('screenshot')) {
    artifactType = 'screenshot'
  } else if (filePath.includes('/videos/') || filePath.includes('video')) {
    artifactType = 'video'
  } else if (filePath.includes('/traces/') || filePath.includes('trace')) {
    artifactType = 'trace'
  }

  // Look up artifact by fileName. Playwright generates unique hash-based names for custom artifacts,
  // but built-in output (video.webm, test-failed-1.png, trace.zip) is generic and shared across tests.
  // We fetch all matches and use testName to pick the right one when there are multiple.
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
      storagePath: testArtifacts.storagePath,
      fileName: testArtifacts.fileName,
      contentType: testArtifacts.contentType,
      metadata: testArtifacts.metadata,
    })
    .from(testArtifacts)
    .where(conditions)

  let artifact = null
  if (matches.length === 1) {
    artifact = matches[0]
  } else if (matches.length > 1) {
    // Multiple tests produced an artifact with the same filename (e.g. video.webm).
    // Use testName (exact, then case-insensitive) to pick the right one.
    artifact = matches.find(a => a.testName === testName)
      ?? matches.find(a => a.testName?.toLowerCase() === testName?.toLowerCase())
      ?? matches[0] // last resort: first match
  }

  if (artifact) {
    console.log(`[artifacts] DB record found for ${fileName} (run ${testRunId})${matches.length > 1 ? ` [disambiguated from ${matches.length} matches]` : ''}`)
  } else {
    console.log(`[artifacts] No DB record for ${fileName}, falling back to local filesystem`)
  }

  // If artifact found in database, try Supabase Storage first
  if (artifact) {
    if (artifact.storageUrl) {
      console.log(`[artifacts] Redirecting to Supabase: ${artifact.storageUrl.substring(0, 80)}...`)
      return NextResponse.redirect(artifact.storageUrl, 307)
    }
    
    // Database record exists but no Supabase URL - search filesystem
    console.log(`[artifacts] DB record exists but no Supabase URL for ${fileName}, searching local filesystem...`)
    const localPath = searchLocalArtifact(fileName, testRun.projectPath)

    if (localPath && fs.existsSync(localPath)) {
      try {
        const fileBuffer = fs.readFileSync(localPath)
        const contentType = artifact.contentType || 'application/octet-stream'

        return new NextResponse(fileBuffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `inline; filename="${artifact.fileName}"`,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Served-From': 'local-filesystem',
          },
        })
      } catch (error) {
        console.error(`[artifacts] Error serving local file:`, error)
        return NextResponse.json(
          {
            error: 'Failed to serve artifact from local filesystem',
            fileName,
          },
          { status: 500 }
        )
      }
    }
    
    // Database record exists but artifact not found
    console.error(`[artifacts] DB record exists but artifact not found in Supabase or local filesystem`)
    return NextResponse.json(
      {
        error: 'Artifact not found',
        message: 'Database record exists but file not available in Supabase Storage or local filesystem',
        fileName,
      },
      { status: 404 }
    )
  }

  // No database record (e.g., live test run) - search filesystem directly
  console.log(`[artifacts] No DB record for ${fileName}, searching local filesystem directly...`)
  const localPath = searchLocalArtifact(fileName, testRun.projectPath)

  if (localPath && fs.existsSync(localPath)) {
    try {
      const fileBuffer = fs.readFileSync(localPath)
      
      // Infer content type from file extension
      const ext = path.extname(fileName).toLowerCase()
      let contentType = 'application/octet-stream'
      if (ext === '.png') contentType = 'image/png'
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg'
      else if (ext === '.webm') contentType = 'video/webm'
      else if (ext === '.mp4') contentType = 'video/mp4'
      else if (ext === '.zip') contentType = 'application/zip'

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${fileName}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Served-From': 'local-filesystem-no-db',
        },
      })
    } catch (error) {
      console.error(`[artifacts] Error serving local file:`, error)
      return NextResponse.json(
        {
          error: 'Failed to serve artifact from local filesystem',
          fileName,
        },
        { status: 500 }
      )
    }
  }

  // Not found anywhere
  return NextResponse.json(
    {
      error: 'Artifact not available',
      fileName,
      hint: 'The artifact was not uploaded to storage and could not be found in local filesystem.',
    },
    { status: 404 }
  )
}
