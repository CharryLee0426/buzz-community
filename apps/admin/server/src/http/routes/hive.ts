import { z } from 'zod'
import { ApiProblem, type AppContext } from '../../context.js'
import { sha256Hex } from '../../nostr/keys.js'
import { safeEqual, type App } from '../app.js'
import type { MiddlewareHandler } from 'hono'

// The agent host's side of the console. These routes sit outside /admin, so
// the gateway never forwards them: they are reachable only on the private
// network, and only with the shared token.
//
// The host polls `desired` and runs exactly that set; it reports back what
// each process is doing. Agent keys leave the database only here, decrypted
// in memory for the host that needs them.

const report = z.object({
  version: z.string().max(40).optional(),
  providers: z.record(z.string(), z.boolean()).default({}),
  agents: z
    .array(
      z.object({
        id: z.uuid(),
        state: z.enum(['starting', 'running', 'backoff', 'failed', 'stopping']),
        detail: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(500)
    .default([]),
})

export function hiveRoutes(app: App, ctx: AppContext) {
  const hiveOnly: MiddlewareHandler = async (c, next) => {
    const expected = ctx.config.HIVE_TOKEN
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!expected || !safeEqual(given, expected)) throw new ApiProblem(401, 'unauthorized', 'Unauthorized.')
    await next()
  }

  app.get('/internal/hive/desired', hiveOnly, async (c) => {
    if (!ctx.store || !ctx.box) throw new ApiProblem(503, 'not_ready', 'The console is not ready to hand out agents.')
    const box = ctx.box
    const agents = (await ctx.store.agents())
      .filter((agent) => agent.desiredState === 'running' && agent.authTag)
      .map((agent) => {
        const spec = {
          id: agent.id,
          name: agent.name,
          about: agent.about,
          pubkey: agent.pubkey,
          authTag: JSON.stringify(agent.authTag),
          ownerPubkey: agent.ownerPubkey,
          // buzz-acp's own names for who an agent answers.
          respondTo: agent.access === 'owner' ? 'owner-only' : agent.access,
          allowlist: agent.allowlist,
          // Who may add the agent to a channel, enforced by the relay.
          addPolicy: agent.access === 'owner' ? 'owner_only' : 'anyone',
          provider: agent.provider,
          model: agent.model,
          instructions: agent.instructions,
        }
        return {
          ...spec,
          secretKey: box.open(agent.secretSealed, `agent:${agent.pubkey}`),
          // Changes whenever anything the process depends on changes, so the
          // host knows to restart it.
          revision: sha256Hex(JSON.stringify(spec)).slice(0, 16),
        }
      })
    return c.json({ agents })
  })

  app.post('/internal/hive/report', hiveOnly, async (c) => {
    const body = report.parse(await c.req.json())
    ctx.hive.lastSeenAt = Date.now()
    ctx.hive.providers = body.providers
    ctx.hive.version = body.version ?? null
    await ctx.store?.reportAgentStatus(body.agents.map((agent) => ({ agentId: agent.id, state: agent.state, detail: agent.detail })))
    return c.body(null, 204)
  })
}
