import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL!
const client = postgres(connectionString, {
  ssl: { rejectUnauthorized: false },
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 30,
  connection: {
    statement_timeout: 30000,
  },
})
export const db = drizzle(client, { schema })
