// =============================================================================
// Idempotent Drizzle migration runner for Docker.
//
// Applies every .sql file in /app/webapp/drizzle in lexical order, tracking
// applied filenames in the public._drizzle_docker_migrations table.
//
// Run via:
//   docker run --rm --env-file .env <image> node /app/webapp/docker/migrate.mjs
// or set RUN_MIGRATIONS=true so entrypoint.sh runs it on every container start.
// =============================================================================
import postgres from 'postgres'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve('/app/webapp/drizzle')
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set')
  process.exit(1)
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  prepare: false,
})

const log = (...args) => console.log('[migrate]', ...args)

try {
  await sql`
    CREATE TABLE IF NOT EXISTS public._drizzle_docker_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const applied = new Set(
    (await sql`SELECT filename FROM public._drizzle_docker_migrations`).map(
      (r) => r.filename,
    ),
  )

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let appliedCount = 0
  for (const file of files) {
    if (applied.has(file)) {
      log(`• skip   ${file} (already applied)`)
      continue
    }
    const fullPath = path.join(MIGRATIONS_DIR, file)
    const ddl = readFileSync(fullPath, 'utf8')
    log(`→ apply  ${file}`)
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl)
      await tx`INSERT INTO public._drizzle_docker_migrations (filename) VALUES (${file})`
    })
    appliedCount += 1
  }

  log(`✓ done — ${appliedCount} new migration(s) applied, ${applied.size} already present`)
} catch (err) {
  console.error('[migrate] ✗ failure:', err.message)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
