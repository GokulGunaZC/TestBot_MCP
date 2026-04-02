import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testLists } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    const [row] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!row) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    const data = {
      id: row.id,
      user_id: row.userId,
      name: row.name,
      description: row.description,
      test_count: row.testCount,
      last_run_at: row.lastRunAt?.toISOString() ?? null,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[Test List] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test list' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { name, description } = body as { name?: string; description?: string }

  try {
    const [existing] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    const updateData: Partial<{ name: string; description: string | null; updatedAt: Date }> = {
      updatedAt: new Date(),
    }
    if (name !== undefined) updateData.name = name.trim()
    if (description !== undefined) updateData.description = description?.trim() || null

    const [row] = await db
      .update(testLists)
      .set(updateData)
      .where(eq(testLists.id, id))
      .returning()

    const data = {
      id: row.id,
      user_id: row.userId,
      name: row.name,
      description: row.description,
      test_count: row.testCount,
      last_run_at: row.lastRunAt?.toISOString() ?? null,
      created_at: row.createdAt?.toISOString() ?? null,
      updated_at: row.updatedAt?.toISOString() ?? null,
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[Test List] PATCH error:', error)
    return NextResponse.json({ error: 'Failed to update test list' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    const [existing] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    await db.delete(testLists).where(eq(testLists.id, id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Test List] DELETE error:', error)
    return NextResponse.json({ error: 'Failed to delete test list' }, { status: 500 })
  }
}
