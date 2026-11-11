import { z } from 'zod'
import { ApiProblem, requireCommands, requireCommunity, requireStore, type AppContext } from '../../context.js'
import { parsePublicKey, sha256Hex, toNpub, unixNow } from '../../nostr/keys.js'
import { readRelayStatus } from '../../relay/status.js'
import type { Collector } from '../../collector.js'
import { API, requireSession, type App } from '../app.js'

const settle = async <T>(work: Promise<T>): Promise<{ value: T | null; error: string | null }> => {
  try {
    return { value: await work, error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const pubkeyParam = (value: string) => {
  const pubkey = parsePublicKey(value)
  if (!pubkey) throw new ApiProblem(400, 'invalid_pubkey', 'That is not a public key. Paste an npub or 64 hex characters.')
  return pubkey
}

const addMember = z.object({
  pubkey: z.string().trim().min(1),
  role: z.enum(['member', 'admin']).default('member'),
})
const changeRole = z.object({ role: z.enum(['member', 'admin']) })
const banMember = z.object({
  reason: z.string().trim().max(280).optional(),
  days: z.number().int().min(1).max(365).optional(),
})
const createInvite = z.object({
  ttlHours: z.number().int().min(1).max(720).default(72),
  maxUses: z.number().int().min(1).max(10_000).nullable().default(1),
  note: z.string().trim().max(120).default(''),
})

export function communityRoutes(app: App, ctx: AppContext, collector: Collector) {
  const guard = requireSession(ctx)

  /** Community totals, with the agents this console hosts counted as agents. */
  const communityCounts = (community: NonNullable<AppContext['community']>) =>
    ctx.cache.get('community.counts', 20_000, async () => {
      const hosted = ctx.store ? await ctx.store.agents().catch(() => []) : []
      return community.counts(
        ctx.signer?.pubkey,
        hosted.map((agent) => agent.pubkey),
      )
    })

  // One call for the landing page. Each part fails on its own so a broken
  // integration shows as a gap, not as a blank overview.
  app.get(`${API}/overview`, guard, async (c) => {
    const community = ctx.community
    const store = ctx.store
    const [relay, counts, messages, samples, services, openAlerts, recentAlerts] = await Promise.all([
      ctx.cache.get('relay.status', 10_000, () => readRelayStatus(ctx.relay, ctx.config.RELAY_HEALTH_URL)),
      settle(community ? communityCounts(community) : Promise.reject(new Error('No database connection.'))),
      settle(community ? ctx.cache.get('community.messages.24', 60_000, () => community.messageSeries(24)) : Promise.reject(new Error('No database connection.'))),
      settle(
        store
          ? ctx.cache.get('samples.24', 60_000, () => store.samples(['relay.connections', 'relay.events_per_minute'], 24))
          : Promise.reject(new Error('No database connection.')),
      ),
      settle(ctx.railway ? ctx.cache.get('railway.services', 20_000, () => ctx.railway!.services()) : Promise.reject(new Error('Railway is not connected.'))),
      settle(store ? store.openAlertCount() : Promise.reject(new Error('No database connection.'))),
      settle(store ? store.alerts({ limit: 6, openOnly: true }) : Promise.reject(new Error('No database connection.'))),
    ])

    return c.json({
      host: ctx.communityHost,
      generatedAt: new Date().toISOString(),
      relay,
      live: collector.latest(),
      counts: counts.value,
      countsError: counts.error,
      messages: messages.value ?? [],
      samples: samples.value ?? [],
      railwayConnected: Boolean(ctx.railway),
      services: services.value,
      servicesError: services.error,
      alerts: { open: openAlerts.value ?? 0, recent: recentAlerts.value ?? [] },
    })
  })

  app.get(`${API}/members`, guard, async (c) => {
    const community = requireCommunity(ctx)
    const [members, hosted] = await Promise.all([community.members(), ctx.store?.agents() ?? []])
    const hostedByPubkey = new Map(hosted.map((agent) => [agent.pubkey, agent.id]))
    return c.json({
      consolePubkey: ctx.signer?.pubkey ?? null,
      members: members.map((member) => ({
        ...member,
        npub: toNpub(member.pubkey),
        // The console's own owner key is a member too, but it is not a person.
        kind:
          member.pubkey === ctx.signer?.pubkey
            ? 'console'
            : member.agentOwner || hostedByPubkey.has(member.pubkey)
              ? 'agent'
              : 'person',
        hostedAgentId: hostedByPubkey.get(member.pubkey) ?? null,
      })),
    })
  })

  app.post(`${API}/members`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const body = addMember.parse(await c.req.json())
    const pubkey = pubkeyParam(body.pubkey)
    await commands.addMember(pubkey, body.role)
    ctx.cache.invalidate('community.')
    await ctx.store?.recordAudit({
      actor: c.get('session').sub,
      action: 'member.added',
      target: pubkey,
      detail: { role: body.role },
      clientIp: c.get('clientIp'),
    })
    return c.json({ pubkey, npub: toNpub(pubkey), role: body.role }, 201)
  })

  app.patch(`${API}/members/:pubkey`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const pubkey = pubkeyParam(c.req.param('pubkey'))
    const { role } = changeRole.parse(await c.req.json())
    await commands.setRole(pubkey, role)
    ctx.cache.invalidate('community.')
    await ctx.store?.recordAudit({ actor: c.get('session').sub, action: 'member.role_changed', target: pubkey, detail: { role }, clientIp: c.get('clientIp') })
    return c.json({ pubkey, role })
  })

  app.delete(`${API}/members/:pubkey`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const pubkey = pubkeyParam(c.req.param('pubkey'))
    await commands.removeMember(pubkey)
    ctx.cache.invalidate('community.')
    await ctx.store?.recordAudit({ actor: c.get('session').sub, action: 'member.removed', target: pubkey, clientIp: c.get('clientIp') })
    return c.body(null, 204)
  })

  app.post(`${API}/members/:pubkey/ban`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const pubkey = pubkeyParam(c.req.param('pubkey'))
    const body = banMember.parse(await c.req.json().catch(() => ({})))
    await commands.ban(pubkey, {
      reason: body.reason || undefined,
      expiresAt: body.days ? unixNow() + body.days * 86_400 : undefined,
    })
    ctx.cache.invalidate('community.')
    await ctx.store?.recordAudit({
      actor: c.get('session').sub,
      action: 'member.banned',
      target: pubkey,
      detail: { days: body.days ?? null, reason: body.reason ?? null },
      clientIp: c.get('clientIp'),
    })
    return c.body(null, 204)
  })

  app.delete(`${API}/members/:pubkey/ban`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const pubkey = pubkeyParam(c.req.param('pubkey'))
    await commands.unban(pubkey)
    ctx.cache.invalidate('community.')
    await ctx.store?.recordAudit({ actor: c.get('session').sub, action: 'member.unbanned', target: pubkey, clientIp: c.get('clientIp') })
    return c.body(null, 204)
  })

  // The relay keeps only a hash of each invite code. Links minted here are
  // stored encrypted so they can be copied again; links minted in the Buzz app
  // show up without one.
  app.get(`${API}/invites`, guard, async (c) => {
    const community = requireCommunity(ctx)
    const store = requireStore(ctx)
    const [invites, saved] = await Promise.all([community.invites(), store.savedInvites()])
    const creators = await community.profiles([...new Set(invites.map((invite) => invite.createdBy))])
    const now = Date.now()
    return c.json({
      invites: invites.map((invite) => {
        const mine = saved.get(invite.tokenHash)
        let url: string | null = null
        if (mine && ctx.box) {
          try {
            url = ctx.box.open(mine.linkSealed, `invite:${invite.tokenHash}`)
          } catch {
            url = null
          }
        }
        const exhausted = invite.maxUses !== null && invite.useCount >= invite.maxUses
        const state = invite.revokedAt ? 'revoked' : new Date(invite.expiresAt).getTime() <= now ? 'expired' : exhausted ? 'used' : 'active'
        return {
          id: invite.id,
          state,
          url: state === 'active' ? url : null,
          note: mine?.note ?? '',
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
          revokedAt: invite.revokedAt,
          maxUses: invite.maxUses,
          useCount: invite.useCount,
          createdBy: invite.createdBy,
          createdByName:
            invite.createdBy === ctx.signer?.pubkey ? (mine?.createdBy ?? 'Console') : (creators.get(invite.createdBy)?.displayName ?? null),
          viaConsole: Boolean(mine),
        }
      }),
    })
  })

  app.post(`${API}/invites`, guard, async (c) => {
    const { commands } = requireCommands(ctx)
    const store = requireStore(ctx)
    const body = createInvite.parse(await c.req.json().catch(() => ({})))
    const invite = await commands.createInvite({ ttlSeconds: body.ttlHours * 3600, maxUses: body.maxUses })
    const tokenHash = sha256Hex(invite.code)
    if (ctx.box) {
      await store.saveInvite({
        tokenHash,
        linkSealed: ctx.box.seal(invite.url, `invite:${tokenHash}`),
        note: body.note,
        createdBy: c.get('session').sub,
      })
    }
    ctx.cache.invalidate('community.')
    await store.recordAudit({
      actor: c.get('session').sub,
      action: 'invite.created',
      target: tokenHash.slice(0, 12),
      detail: { ttlHours: body.ttlHours, maxUses: body.maxUses, note: body.note },
      clientIp: c.get('clientIp'),
    })
    // Without the encryption key the link exists only in this response.
    return c.json({ url: invite.url, expiresAt: new Date(invite.expiresAt * 1000).toISOString(), maxUses: invite.maxUses, saved: Boolean(ctx.box) }, 201)
  })

  app.delete(`${API}/invites/:id`, guard, async (c) => {
    const community = requireCommunity(ctx)
    const store = requireStore(ctx)
    const id = z.uuid().parse(c.req.param('id'))
    const communityId = await community.communityId()
    if (!communityId) throw new ApiProblem(503, 'community_missing', 'The relay has not created the community yet.')
    const revoked = await store.revokeInvite(communityId, id)
    if (!revoked) throw new ApiProblem(404, 'invite_not_found', 'That invite does not exist or was already revoked.')
    ctx.cache.invalidate('community.')
    await store.recordAudit({ actor: c.get('session').sub, action: 'invite.revoked', target: id, clientIp: c.get('clientIp') })
    return c.body(null, 204)
  })

  app.get(`${API}/channels`, guard, async (c) => {
    const community = requireCommunity(ctx)
    const [channels, totals] = await Promise.all([community.channels(), communityCounts(community)])
    return c.json({ channels, privateChannels: totals.privateChannels, directMessages: totals.directMessages })
  })
}
