import { createHash } from 'crypto'
import { db } from './db'
import { idempotencyKeys } from './db/schema'
import { and, eq } from 'drizzle-orm'
import { logInfo } from './security-logger'

export function hashResponse(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export async function checkIdempotency(params: {
  idempotencyKey: string
  userId: string
  endpoint: string
}): Promise<{ isDuplicate: true; cachedBody: unknown } | { isDuplicate: false }> {
  const [existing] = await db
    .select({ responseBody: idempotencyKeys.responseBody })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.idempotencyKey, params.idempotencyKey),
        eq(idempotencyKeys.userId, params.userId),
        eq(idempotencyKeys.endpoint, params.endpoint)
      )
    )
    .limit(1)

  if (existing) {
    logInfo('IDEMPOTENT_REPLAY', {
      user_id: params.userId,
      endpoint: params.endpoint,
      idempotency_key: params.idempotencyKey,
    })
    return { isDuplicate: true, cachedBody: existing.responseBody }
  }

  return { isDuplicate: false }
}

export async function storeIdempotencyResult(params: {
  idempotencyKey: string
  userId: string
  endpoint: string
  responseBody: unknown
}): Promise<void> {
  const responseHash = hashResponse(params.responseBody)

  try {
    await db.insert(idempotencyKeys).values({
      idempotencyKey: params.idempotencyKey,
      userId: params.userId,
      endpoint: params.endpoint,
      responseHash,
      responseBody: params.responseBody as Record<string, unknown>,
    })
  } catch {
    // Ignore duplicate key insert races
  }
}
