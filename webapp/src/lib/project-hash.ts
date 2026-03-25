import { createHash } from 'crypto'
import { db } from './db'
import { projectUsage } from './db/schema'
import { eq, ne, and, count } from 'drizzle-orm'
import { logInfo } from './security-logger'

export function generateProjectHash(projectPath: string): string {
  const normalized = projectPath.trim().toLowerCase().replace(/\\/g, '/')
  return createHash('sha256').update(normalized).digest('hex')
}

export async function trackProjectUsage(params: {
  projectPath: string
  userId: string
}): Promise<void> {
  const projectHash = generateProjectHash(params.projectPath)

  try {
    // Upsert: insert or update last_seen_at
    const existing = await db
      .select({ id: projectUsage.id })
      .from(projectUsage)
      .where(
        and(
          eq(projectUsage.projectHash, projectHash),
          eq(projectUsage.userId, params.userId)
        )
      )
      .limit(1)

    if (existing.length === 0) {
      await db.insert(projectUsage).values({
        projectHash,
        userId: params.userId,
      })
    } else {
      await db
        .update(projectUsage)
        .set({ lastSeenAt: new Date() })
        .where(
          and(
            eq(projectUsage.projectHash, projectHash),
            eq(projectUsage.userId, params.userId)
          )
        )
    }

    // Check for multi-account usage of the same project
    const [{ otherUserCount }] = await db
      .select({ otherUserCount: count() })
      .from(projectUsage)
      .where(
        and(
          eq(projectUsage.projectHash, projectHash),
          ne(projectUsage.userId, params.userId)
        )
      )

    if (otherUserCount > 0) {
      logInfo('MULTI_ACCOUNT_PROJECT_DETECTED', {
        project_hash: projectHash,
        user_id: params.userId,
        other_account_count: otherUserCount,
      })
    }
  } catch {
    // Non-blocking
  }
}
