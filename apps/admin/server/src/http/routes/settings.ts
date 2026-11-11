import { z } from 'zod'
import { hiveOnline, requireStore, type AppContext } from '../../context.js'
import { toNpub } from '../../nostr/keys.js'
import { API, BASE, requireSession, type App } from '../app.js'

export function settingsRoutes(app: App, ctx: AppContext) {
  const guard = requireSession(ctx)

  // What the console is connected to, so a missing integration reads as a
  // named gap with its fix instead of as empty pages.
  app.get(`${API}/settings`, guard, (c) => {
    const { config } = ctx
    return c.json({
      community: {
        host: ctx.communityHost,
        address: `wss://${ctx.communityHost}`,
        consolePubkey: ctx.signer?.pubkey ?? null,
        consoleNpub: ctx.signer ? toNpub(ctx.signer.pubkey) : null,
      },
      integrations: {
        database: Boolean(ctx.community),
        ownerKey: Boolean(ctx.signer),
        encryptionKey: Boolean(ctx.box),
        railway: Boolean(ctx.railway),
        hive: {
          tokenConfigured: Boolean(config.HIVE_TOKEN),
          online: hiveOnline(ctx.hive),
          lastSeenAt: ctx.hive.lastSeenAt ? new Date(ctx.hive.lastSeenAt).toISOString() : null,
          providers: ctx.hive.providers,
        },
        webhook: {
          configured: Boolean(config.WEBHOOK_TOKEN),
          // Shown to the signed-in operator so it can be pasted into Railway.
          url: config.WEBHOOK_TOKEN ? `${config.PUBLIC_ORIGIN}${BASE}/hooks/railway/${config.WEBHOOK_TOKEN}` : null,
        },
        alertForwarding: Boolean(config.ALERT_FORWARD_URL),
      },
      deployment: {
        projectId: config.RAILWAY_PROJECT_ID ?? null,
        environment: config.RAILWAY_ENVIRONMENT_NAME ?? null,
        deploymentId: config.RAILWAY_DEPLOYMENT_ID ?? null,
      },
      session: { username: c.get('session').sub, lifetimeHours: config.SESSION_TTL_HOURS },
    })
  })

  app.get(`${API}/audit`, guard, async (c) => {
    const store = requireStore(ctx)
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(c.req.query('limit'))
    return c.json({ entries: await store.auditLog(limit) })
  })
}
