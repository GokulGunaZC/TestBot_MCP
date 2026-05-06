import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { importSessions, importedTestCases, generatedGroovyFiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { generateGroovyFile } from '@/lib/groovy-generator'

// Allow up to 5 minutes for parallel Groovy generation (Next.js default is 60s)
export const maxDuration = 300

// Derive the unique set of API class names from test case scenarios
function extractApiTypesFromCases(
  cases: { scenario: string | null }[]
): string[] {
  const abbrevToClass: Record<string, string> = {
    AS: 'AirShoppingRQ',
    OP: 'OfferPriceRQ',
    OC: 'OrderCreateRQ',
    OR: 'OrderRetrieveRQ',
    OCH: 'OrderChangeRQ',
    ORS: 'OrderReshopRQ',
    Exch: 'OrderExchangeRQ',
    SA: 'SeatAvailabilityRQ',
    PCL: 'PriceCalendarRQ',
    TI: 'TicketIssuanceRQ',
    FP: 'FarePriceRQ',
    AV: 'AirAvailabilityRQ',
    PR: 'PriceRQ',
  }

  const found = new Set<string>()
  for (const tc of cases) {
    if (!tc.scenario) continue
    for (const token of tc.scenario.split(/->|,|\s+/)) {
      const cls = abbrevToClass[token.trim()]
      if (cls) found.add(cls)
    }
  }

  // Return in a deterministic order matching the abbreviation map order
  const orderedClasses = Object.values(abbrevToClass)
  return orderedClasses.filter((cls) => found.has(cls)).filter((cls, i, arr) => arr.indexOf(cls) === i)
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const [session] = await db
    .select()
    .from(importSessions)
    .where(and(eq(importSessions.id, id), eq(importSessions.userId, user.id)))
    .limit(1)

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (session.status === 'processing') {
    return NextResponse.json({ error: 'Generation already in progress' }, { status: 409 })
  }

  if (session.status === 'completed') {
    return NextResponse.json({ error: 'Already generated. Delete existing files first.' }, { status: 409 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 503 })
  }

  // Clear any previous (failed) groovy files before re-generating
  await db.delete(generatedGroovyFiles).where(eq(generatedGroovyFiles.importId, id))

  // Mark as processing
  await db
    .update(importSessions)
    .set({ status: 'processing', groovyFileCount: 0, updatedAt: new Date() })
    .where(eq(importSessions.id, id))

  const testCases = await db
    .select()
    .from(importedTestCases)
    .where(eq(importedTestCases.importId, id))

  const apiTypes = extractApiTypesFromCases(testCases)

  if (apiTypes.length === 0) {
    await db
      .update(importSessions)
      .set({ status: 'failed', errorMessage: 'No recognizable API types found in scenarios', updatedAt: new Date() })
      .where(eq(importSessions.id, id))
    return NextResponse.json({ error: 'No API types found in test case scenarios' }, { status: 422 })
  }

  const parsedCases = testCases.map((tc) => ({
    tc_id: tc.tcId,
    active: tc.active,
    functional_area: tc.functionalArea,
    scenario: tc.scenario,
    description: tc.description,
    environment_name: tc.environmentName,
    ndc_version: tc.ndcVersion,
    pcc: tc.pcc,
    raw_data: (tc.rawData as Record<string, unknown>) ?? {},
  }))

  // Generate all Groovy files in parallel to avoid sequential timeout
  const generationPromises = apiTypes.map((apiType) =>
    generateGroovyFile(apiType, parsedCases, apiKey)
      .then((result) => ({ apiType, result, error: null }))
      .catch((err) => ({
        apiType,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      }))
  )

  const generationResults = await Promise.all(generationPromises)

  const results = []
  let hadError = false

  for (const { apiType, result, error } of generationResults) {
    if (error || !result) {
      // Generation threw an exception before returning a result
      const [inserted] = await db
        .insert(generatedGroovyFiles)
        .values({
          importId: id,
          fileName: `${apiType}.groovy`,
          className: apiType,
          apiType,
          groovyContent: `// Generation failed: ${error}`,
          status: 'failed',
          errorMessage: error ?? 'Unknown error',
        })
        .returning()

      results.push({
        id: inserted.id,
        file_name: inserted.fileName,
        class_name: inserted.className,
        api_type: inserted.apiType,
        status: inserted.status,
        error_message: inserted.errorMessage,
      })
      hadError = true
      continue
    }

    const [inserted] = await db
      .insert(generatedGroovyFiles)
      .values({
        importId: id,
        fileName: result.fileName,
        className: result.className,
        apiType: result.apiType,
        groovyContent: result.content,
        status: result.error ? 'failed' : 'generated',
        errorMessage: result.error ?? null,
      })
      .returning()

    results.push({
      id: inserted.id,
      file_name: inserted.fileName,
      class_name: inserted.className,
      api_type: inserted.apiType,
      status: inserted.status,
      error_message: inserted.errorMessage,
    })

    if (result.error) hadError = true
  }

  const finalStatus = hadError ? (results.some((r) => r.status === 'generated') ? 'completed' : 'failed') : 'completed'

  await db
    .update(importSessions)
    .set({
      status: finalStatus,
      groovyFileCount: results.filter((r) => r.status === 'generated').length,
      updatedAt: new Date(),
    })
    .where(eq(importSessions.id, id))

  return NextResponse.json({ success: true, groovy_files: results })
}
