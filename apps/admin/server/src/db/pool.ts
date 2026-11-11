import pg from 'pg'
import type { Logger } from '../log.js'

// Two pools over the relay's database, deliberately separate:
//
//   community  reads the relay's own tables. Every transaction is read-only,
//              so a bug here cannot change community data, and statements are
//              cut off quickly so a dashboard query can never hold the relay up.
//   console    owns the `console` schema, where this service keeps its state.
//
// Both stay small: the relay needs the connections more than the console does.

export interface Database {
  community: pg.Pool
  console: pg.Pool
  close(): Promise<void>
}

export function createDatabase(connectionString: string, log: Logger): Database {
  const base = {
    connectionString,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'buzz-console',
  }
  const community = new pg.Pool({
    ...base,
    max: 4,
    options: '-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000',
  })
  const consolePool = new pg.Pool({
    ...base,
    max: 4,
    // `public` stays on the path because the one statement that touches a relay
    // table fires the relay's triggers, and those call their functions unqualified.
    options: '-c statement_timeout=15000 -c lock_timeout=5000 -c search_path=console,public',
  })
  // A dropped idle connection must not take the process down; the pool replaces it.
  for (const [name, pool] of [['community', community], ['console', consolePool]] as const) {
    pool.on('error', (err) => log.warn({ err, pool: name, component: 'db' }, 'idle database connection failed'))
  }
  return {
    community,
    console: consolePool,
    async close() {
      await Promise.allSettled([community.end(), consolePool.end()])
    },
  }
}
