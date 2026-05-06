import postgres from 'postgres'
import { readFileSync } from 'fs'

const sql = readFileSync('./drizzle/0009_stripe_subscription.sql', 'utf8')
const db = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 })

try {
  await db.unsafe(sql)
  console.log('Migration 0009_stripe_subscription applied successfully')
} catch (err) {
  console.error('Migration error:', err.message)
  process.exit(1)
} finally {
  await db.end()
}
