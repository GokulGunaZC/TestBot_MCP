import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { importSessions, importedTestCases, generatedGroovyFiles } from '@/lib/db/schema'
import { eq, and, asc } from 'drizzle-orm'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const [session] = await db
    .select()
    .from(importSessions)
    .where(and(eq(importSessions.id, id), eq(importSessions.userId, user.id)))
    .limit(1)

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const testCases = await db
    .select()
    .from(importedTestCases)
    .where(eq(importedTestCases.importId, id))
    .orderBy(asc(importedTestCases.createdAt))

  const groovyFiles = await db
    .select()
    .from(generatedGroovyFiles)
    .where(eq(generatedGroovyFiles.importId, id))
    .orderBy(asc(generatedGroovyFiles.createdAt))

  return NextResponse.json({
    import: {
      id: session.id,
      user_id: session.userId,
      name: session.name,
      description: session.description,
      original_filename: session.originalFilename,
      file_storage_path: session.fileStoragePath,
      status: session.status,
      test_case_count: session.testCaseCount,
      groovy_file_count: session.groovyFileCount,
      error_message: session.errorMessage,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    },
    test_cases: testCases.map((tc) => ({
      id: tc.id,
      import_id: tc.importId,
      tc_id: tc.tcId,
      active: tc.active,
      functional_area: tc.functionalArea,
      scenario: tc.scenario,
      description: tc.description,
      environment_name: tc.environmentName,
      ndc_version: tc.ndcVersion,
      pcc: tc.pcc,
      raw_data: tc.rawData,
      created_at: tc.createdAt,
    })),
    groovy_files: groovyFiles.map((f) => ({
      id: f.id,
      import_id: f.importId,
      file_name: f.fileName,
      class_name: f.className,
      api_type: f.apiType,
      groovy_content: f.groovyContent,
      status: f.status,
      error_message: f.errorMessage,
      created_at: f.createdAt,
    })),
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const [session] = await db
    .select()
    .from(importSessions)
    .where(and(eq(importSessions.id, id), eq(importSessions.userId, user.id)))
    .limit(1)

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.delete(importSessions).where(eq(importSessions.id, id))

  return NextResponse.json({ success: true })
}
