import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testLists, testListItems, testRuns } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  try {
    // Verify list belongs to user
    const [list] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!list) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    // Get items for this list
    const items = await db
      .select()
      .from(testListItems)
      .where(eq(testListItems.listId, id))
      .orderBy(desc(testListItems.createdAt))

    const mappedItems = items.map(row => ({
      id: row.id,
      list_id: row.listId,
      test_run_id: row.testRunId,
      test_name: row.testName,
      test_config: row.testConfig,
      created_at: row.createdAt?.toISOString() ?? null,
    }))

    return NextResponse.json({ data: mappedItems })
  } catch (error) {
    console.error('[Test List Items] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch test list items' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { test_name, test_run_id, test_config } = body as {
    test_name: string
    test_run_id?: string
    test_config?: Record<string, unknown>
  }

  if (!test_name?.trim()) {
    return NextResponse.json({ error: 'Test name is required' }, { status: 400 })
  }

  try {
    // Verify list belongs to user
    const [list] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!list) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    // If test_run_id provided, verify it belongs to user
    if (test_run_id) {
      const [run] = await db
        .select()
        .from(testRuns)
        .where(and(eq(testRuns.id, test_run_id), eq(testRuns.userId, user.id)))
        .limit(1)

      if (!run) {
        return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
      }
    }

    // Insert the item
    const [row] = await db
      .insert(testListItems)
      .values({
        listId: id,
        testRunId: test_run_id ?? null,
        testName: test_name.trim(),
        testConfig: test_config ?? null,
      })
      .returning()

    // Update test count on the list
    await db
      .update(testLists)
      .set({
        testCount: (list.testCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(testLists.id, id))

    const data = {
      id: row.id,
      list_id: row.listId,
      test_run_id: row.testRunId,
      test_name: row.testName,
      test_config: row.testConfig,
      created_at: row.createdAt?.toISOString() ?? null,
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error('[Test List Items] POST error:', error)
    return NextResponse.json({ error: 'Failed to add test to list' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const itemId = searchParams.get('item_id')

  if (!itemId) {
    return NextResponse.json({ error: 'item_id is required' }, { status: 400 })
  }

  try {
    // Verify list belongs to user
    const [list] = await db
      .select()
      .from(testLists)
      .where(and(eq(testLists.id, id), eq(testLists.userId, user.id)))
      .limit(1)

    if (!list) {
      return NextResponse.json({ error: 'Test list not found' }, { status: 404 })
    }

    // Verify item exists and belongs to this list
    const [item] = await db
      .select()
      .from(testListItems)
      .where(and(eq(testListItems.id, itemId), eq(testListItems.listId, id)))
      .limit(1)

    if (!item) {
      return NextResponse.json({ error: 'Test item not found' }, { status: 404 })
    }

    // Delete the item
    await db.delete(testListItems).where(eq(testListItems.id, itemId))

    // Update test count on the list
    await db
      .update(testLists)
      .set({
        testCount: Math.max(0, (list.testCount ?? 0) - 1),
        updatedAt: new Date(),
      })
      .where(eq(testLists.id, id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Test List Items] DELETE error:', error)
    return NextResponse.json({ error: 'Failed to remove test from list' }, { status: 500 })
  }
}
