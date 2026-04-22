import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { importSessions, generatedGroovyFiles } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, fileId } = await params

  // Verify ownership via import session
  const [session] = await db
    .select()
    .from(importSessions)
    .where(and(eq(importSessions.id, id), eq(importSessions.userId, user.id)))
    .limit(1)

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [file] = await db
    .select()
    .from(generatedGroovyFiles)
    .where(and(eq(generatedGroovyFiles.id, fileId), eq(generatedGroovyFiles.importId, id)))
    .limit(1)

  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 })

  return new NextResponse(file.groovyContent, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.fileName}"`,
    },
  })
}
