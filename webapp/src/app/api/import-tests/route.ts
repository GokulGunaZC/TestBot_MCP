import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { importSessions, importedTestCases } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { parseExcelTCG } from '@/lib/excel-parser'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessions = await db
    .select()
    .from(importSessions)
    .where(eq(importSessions.userId, user.id))
    .orderBy(desc(importSessions.createdAt))

  const data = sessions.map((s) => ({
    id: s.id,
    user_id: s.userId,
    name: s.name,
    description: s.description,
    original_filename: s.originalFilename,
    file_storage_path: s.fileStoragePath,
    status: s.status,
    test_case_count: s.testCaseCount,
    groovy_file_count: s.groovyFileCount,
    error_message: s.errorMessage,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }))

  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'file is required' }, { status: 400 })

  const name = (formData.get('name') as string | null)?.trim() || file.name.replace(/\.[^.]+$/, '')
  const description = (formData.get('description') as string | null)?.trim() || null

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  let parsed
  try {
    parsed = parseExcelTCG(buffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to parse Excel file'
    return NextResponse.json({ error: msg }, { status: 422 })
  }

  const [session] = await db
    .insert(importSessions)
    .values({
      userId: user.id,
      name,
      description,
      originalFilename: file.name,
      status: 'pending',
      testCaseCount: parsed.testCases.length,
    })
    .returning()

  if (parsed.testCases.length > 0) {
    await db.insert(importedTestCases).values(
      parsed.testCases.map((tc) => ({
        importId: session.id,
        tcId: tc.tc_id,
        active: tc.active,
        functionalArea: tc.functional_area,
        scenario: tc.scenario,
        description: tc.description,
        environmentName: tc.environment_name,
        ndcVersion: tc.ndc_version,
        pcc: tc.pcc,
        rawData: tc.raw_data,
      }))
    )
  }

  return NextResponse.json(
    {
      import_id: session.id,
      name: session.name,
      test_case_count: parsed.testCases.length,
      api_types: parsed.apiTypes,
    },
    { status: 201 }
  )
}
