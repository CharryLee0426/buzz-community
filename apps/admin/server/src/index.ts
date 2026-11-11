import { serve } from '@hono/node-server'
import { createSessionCodec } from './auth/session.js'
import { createLoginThrottle } from './auth/throttle.js'
import { createCollector } from './collector.js'
import { ConfigError, loadConfig } from './config.js'
import { createCache, type AppContext } from './context.js'
import { createSecretBox } from './crypto/secretbox.js'
import { createCommunityStore } from './db/community.js'
import { createConsoleStore } from './db/console.js'
import { migrate } from './db/migrations.js'
import { createDatabase, type Database } from './db/pool.js'
import { BASE, createApp } from './http/app.js'
import { agentRoutes } from './http/routes/agents.js'
import { communityRoutes } from './http/routes/community.js'
import { hiveRoutes } from './http/routes/hive.js'
import { operationsRoutes } from './http/routes/operations.js'
import { sessionRoutes } from './http/routes/session.js'
import { settingsRoutes } from './http/routes/settings.js'
import { staticRoutes } from './http/static.js'
import { createLogger } from './log.js'
import { createSigner, parseSecretKey } from './nostr/keys.js'
import { createRailwayClient } from './railway/client.js'
import { createRelayClient } from './relay/client.js'
import { createRelayCommands } from './relay/commands.js'

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    // Configuration problems are the most common reason a deploy fails; say
    // exactly which variable is wrong, as one structured line.
    createLogger('info').fatal(
      { component: 'startup', problems: error instanceof ConfigError ? error.problems : undefined, err: error instanceof ConfigError ? undefined : error },
      'invalid configuration; the console cannot start',
    )
    process.exit(1)
  }

  const log = createLogger(config.LOG_LEVEL)
  const communityHost = new URL(config.PUBLIC_ORIGIN).host

  const ctx: AppContext = {
    config,
    log,
    sessions: createSessionCodec(config.SESSION_SECRET, Math.round(config.SESSION_TTL_HOURS * 3600)),
    throttle: createLoginThrottle(),
    communityHost,
    relay: createRelayClient(config.RELAY_URL ?? config.PUBLIC_ORIGIN, communityHost),
    hive: { lastSeenAt: null, providers: {}, version: null },
    cache: createCache(),
  }

  if (config.CONSOLE_SECRET_KEY) {
    ctx.signer = createSigner(parseSecretKey(config.CONSOLE_SECRET_KEY))
    ctx.commands = createRelayCommands(ctx.relay, ctx.signer)
  } else {
    log.warn({ component: 'startup' }, 'CONSOLE_SECRET_KEY is not set; member and invite changes are disabled')
  }
  if (config.CONSOLE_ENCRYPTION_KEY) ctx.box = createSecretBox(config.CONSOLE_ENCRYPTION_KEY)
  else log.warn({ component: 'startup' }, 'CONSOLE_ENCRYPTION_KEY is not set; hosted agents and saved invite links are disabled')

  if (config.RAILWAY_API_TOKEN && config.RAILWAY_PROJECT_ID && config.RAILWAY_ENVIRONMENT_ID) {
    ctx.railway = createRailwayClient({
      token: config.RAILWAY_API_TOKEN,
      projectId: config.RAILWAY_PROJECT_ID,
      environmentId: config.RAILWAY_ENVIRONMENT_ID,
    })
  } else {
    log.warn({ component: 'startup' }, 'RAILWAY_API_TOKEN is not set; logs, metrics and deployments are unavailable in the console')
  }

  let database: Database | undefined
  if (config.DATABASE_URL) {
    database = createDatabase(config.DATABASE_URL, log)
    try {
      await migrate(database.console, log)
      ctx.community = createCommunityStore(database.community, communityHost)
      ctx.store = createConsoleStore(database.console)
    } catch (error) {
      // Start anyway: sign-in and the Railway views do not need the database,
      // and an operator needs the console most when something is broken.
      log.error({ component: 'startup', err: error }, 'database is unavailable; community pages are disabled until restart')
    }
  } else {
    log.warn({ component: 'startup' }, 'DATABASE_URL is not set; community pages are disabled')
  }

  const collector = createCollector(ctx)
  const app = createApp(ctx)

  // Liveness for Railway's deploy-time check. It answers as soon as the
  // process can serve; it deliberately does not depend on Postgres or the relay.
  app.get(`${BASE}/healthz`, (c) => c.json({ status: 'ok' }))

  sessionRoutes(app, ctx)
  communityRoutes(app, ctx, collector)
  agentRoutes(app, ctx)
  operationsRoutes(app, ctx)
  settingsRoutes(app, ctx)
  hiveRoutes(app, ctx)
  staticRoutes(app, config.STATIC_DIR, log)

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    log.info(
      {
        component: 'startup',
        port: info.port,
        community: communityHost,
        database: Boolean(ctx.community),
        owner_key: Boolean(ctx.signer),
        railway: Boolean(ctx.railway),
      },
      'console listening',
    )
    collector.start()
  })

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    log.info({ component: 'shutdown', signal }, 'shutting down')
    collector.stop()
    // Stop accepting, let in-flight requests finish, then release the pools.
    server.close(() => {
      void (database?.close() ?? Promise.resolve()).finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 15_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => log.error({ component: 'process', err: reason }, 'unhandled rejection'))
}

void main()
