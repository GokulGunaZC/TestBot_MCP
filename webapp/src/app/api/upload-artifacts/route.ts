import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys, testArtifacts, testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { uploadArtifactsBatch, ensureBucketExists } from '@/lib/storage/supabase-storage'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateArtifacts } from '@/lib/validation'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/upload-artifacts'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // 1. API key presence check (header or body)
    const rawKey = request.headers.get('x-api-key') ?? null
    const api_key: string = rawKey ?? body?.api_key ?? ''
    const { run_id, artifacts } = body

    if (!api_key) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No x-api-key header or api_key body field', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Missing api_key' }, { status: 401 })
    }

    if (!run_id) {
      return NextResponse.json({ error: 'Missing run_id' }, { status: 400 })
    }

    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      return NextResponse.json({ error: 'Missing or empty artifacts array' }, { status: 400 })
    }

    // 2. Authenticate — validate key, check isActive and NOT revoked, check expiry
    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has been revoked' }, { status: 401 })
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json({ error: 'API key has expired' }, { status: 401 })
    }

    const userId = apiKeyRecord.userId

    // 3. Rate limit check
    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    // 6. Input validation — artifact size
    const artifactValidationError = validateArtifacts(artifacts, userId, ENDPOINT)
    if (artifactValidationError) {
      return NextResponse.json(artifactValidationError, { status: 422 })
    }

    // 2. Verify test run exists and belongs to user
    const [testRun] = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(and(eq(testRuns.id, run_id), eq(testRuns.userId, userId)))
      .limit(1)

    if (!testRun) {
      return NextResponse.json({ error: 'Test run not found or unauthorized' }, { status: 404 })
    }

    // 3. Ensure bucket exists
    await ensureBucketExists()

    // 4. Process artifacts (decode base64 and prepare for upload)
    interface ArtifactPayload {
      test_name: string
      type: 'screenshot' | 'video' | 'trace'
      file_name: string
      content: string // base64
      content_type: string
      metadata?: Record<string, unknown>
    }

    const uploadParams = (artifacts as ArtifactPayload[]).map((artifact) => {
      const fileBuffer = Buffer.from(artifact.content, 'base64')
      return {
        runId: run_id,
        testName: artifact.test_name,
        artifactType: artifact.type,
        fileName: artifact.file_name,
        fileBuffer,
        contentType: artifact.content_type,
        metadata: artifact.metadata || {},
      }
    })

    // 5. Upload to Supabase Storage
    const uploadedArtifacts = await uploadArtifactsBatch(uploadParams)

    // 6. Store artifact records in DB
    const artifactRecords = uploadedArtifacts.map((uploaded, index) => ({
      testRunId: run_id,
      testName: artifacts[index].test_name,
      artifactType: artifacts[index].type,
      storageUrl: uploaded.storageUrl,
      storagePath: uploaded.storagePath,
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize,
      contentType: uploaded.contentType,
      metadata: artifacts[index].metadata || {},
    }))

    if (artifactRecords.length > 0) {
      await db.insert(testArtifacts).values(artifactRecords)
    }

    // 7. Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))

    return NextResponse.json({
      success: true,
      uploaded: uploadedArtifacts.length,
      artifacts: uploadedArtifacts.map((a) => ({
        storage_url: a.storageUrl,
        storage_path: a.storagePath,
        file_name: a.fileName,
        file_size: a.fileSize,
      })),
    })
  } catch (error) {
    console.error('[upload-artifacts] error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}
