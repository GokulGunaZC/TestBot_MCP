import { logBlockedRequest } from './security-logger'

const RATE_LIMIT_PER_SECOND = parseInt(process.env.RATE_LIMIT_PER_SECOND ?? '10', 10)
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '200', 10)

// ── In-memory sliding window store ───────────────────────────────────
interface WindowEntry {
  timestamps: number[]
}

const store = new Map<string, WindowEntry>()

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter((t) => now - t < windowMs)
}

function checkInMemory(
  key: string,
  limitPerSec: number,
  limitPerMin: number,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = store.get(key) ?? { timestamps: [] }

  const lastSecond = pruneTimestamps(entry.timestamps, 1_000, now)
  const lastMinute = pruneTimestamps(entry.timestamps, 60_000, now)

  if (lastSecond.length >= limitPerSec) {
    const oldest = lastSecond[0]
    const retryAfter = Math.ceil((oldest + 1_000 - now) / 1000)
    return { allowed: false, retryAfter: Math.max(1, retryAfter) }
  }

  if (lastMinute.length >= limitPerMin) {
    const oldest = lastMinute[0]
    const retryAfter = Math.ceil((oldest + 60_000 - now) / 1000)
    return { allowed: false, retryAfter: Math.max(1, retryAfter) }
  }

  const merged = pruneTimestamps([...lastMinute, now], 60_000, now)
  store.set(key, { timestamps: merged })

  // Evict stale keys periodically (every ~500 entries checked)
  if (Math.random() < 0.002) {
    for (const [k, v] of store.entries()) {
      if (pruneTimestamps(v.timestamps, 60_000, now).length === 0) {
        store.delete(k)
      }
    }
  }

  return { allowed: true }
}

// ── Optional Redis path ───────────────────────────────────────────────
let redisClient: {
  multi: () => {
    zadd: (key: string, score: number, member: string) => unknown
    zremrangebyscore: (key: string, min: number, max: number) => unknown
    zcard: (key: string) => unknown
    expire: (key: string, seconds: number) => unknown
    exec: () => Promise<unknown[]>
  }
} | null = null

async function getRedisClient() {
  if (!process.env.REDIS_URL) return null
  if (redisClient) return redisClient

  try {
    // @ts-expect-error — ioredis is an optional dependency; install with: npm i ioredis
    const { default: Redis } = await import(/* webpackIgnore: true */ 'ioredis')
    redisClient = new Redis(process.env.REDIS_URL) as typeof redisClient
    return redisClient
  } catch {
    return null
  }
}

async function checkRedis(
  key: string,
  limitPerSec: number,
  limitPerMin: number,
): Promise<{ allowed: boolean; retryAfter?: number } | null> {
  const client = await getRedisClient()
  if (!client) return null

  const now = Date.now()

  try {
    const secKey = `${key}:s`
    const minKey = `${key}:m`

    const pipeline = client.multi()
    pipeline.zadd(secKey, now, `${now}-${Math.random()}`)
    pipeline.zremrangebyscore(secKey, 0, now - 1_000)
    pipeline.zcard(secKey)
    pipeline.expire(secKey, 2)
    pipeline.zadd(minKey, now, `${now}-${Math.random()}`)
    pipeline.zremrangebyscore(minKey, 0, now - 60_000)
    pipeline.zcard(minKey)
    pipeline.expire(minKey, 120)
    const results = await pipeline.exec()

    if (!results) return null

    const secCount = results[2] as [null, number]
    const minCount = results[6] as [null, number]

    if (secCount[1] > limitPerSec) {
      return { allowed: false, retryAfter: 1 }
    }
    if (minCount[1] > limitPerMin) {
      return { allowed: false, retryAfter: 60 }
    }

    return { allowed: true }
  } catch {
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────
export async function checkRateLimit(params: {
  keyHash: string
  userId?: string
  endpoint?: string
  limitPerSecond?: number
  limitPerMinute?: number
}): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `rate_limit:${params.keyHash}`
  const perSec = params.limitPerSecond ?? RATE_LIMIT_PER_SECOND
  const perMin = params.limitPerMinute ?? RATE_LIMIT_PER_MINUTE

  const redisResult = await checkRedis(key, perSec, perMin)
  const result = redisResult ?? checkInMemory(key, perSec, perMin)

  if (!result.allowed) {
    logBlockedRequest({
      type: 'RATE_LIMIT_EXCEEDED',
      user_id: params.userId,
      reason: `Rate limit exceeded for key`,
      endpoint: params.endpoint,
      metadata: { retryAfter: result.retryAfter },
    })
  }

  return result
}
