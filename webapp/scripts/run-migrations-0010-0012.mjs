import postgres from 'postgres'
import { readFileSync } from 'fs'

// 0010 is destructive (zeros tokens_remaining for any row where it exceeded
// tokens_total) and is intentionally omitted from this batch — apply it
// separately after taking a snapshot. 0011 and 0012 are pure CREATE TABLE.
const FILES = [
  './drizzle/0011_token_ledger.sql',
  './drizzle/0012_payments.sql',
]

const db = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 })

try {
  for (const file of FILES) {
    const sql = readFileSync(file, 'utf8')
    console.log(`\n── applying ${file} ──`)
    await db.unsafe(sql)
    console.log(`✓ ${file}`)
  }
  console.log('\nAll migrations applied successfully.')
} catch (err) {
  console.error('\n✗ Migration error:', err.message)
  process.exit(1)
} finally {
  await db.end()
}
