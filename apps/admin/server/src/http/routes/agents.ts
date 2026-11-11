import { z } from 'zod'
import { ApiProblem, HIVE_STALE_MS, hiveOnline, requireCommands, requireCommunity, requireStore, type AppContext, type HiveState } from '../../context.js'
import type { AgentRecord } from '../../db/console.js'
import { createAuthTag, verifyAuthTag } from '../../nostr/attestation.js'
import { createSigner, newSecretKeyHex, parsePublicKey, parseSecretKey, toNpub } from '../../nostr/keys.js'
import { API, requireSession, type App } from '../app.js'

// Where an agent may run follows from who it answers:
//
//   personal  answers its owner only. It may run in the owner's Buzz app or
//             here; when hosted here the owner authorizes it from their app.
//   shared    answers an allowlist or every member. It always runs here, under
//             a custodian key the console keeps for that agent alone, so no
//             member's identity vouches for what others ask it to do.
//
// The same rule is a CHECK constraint on console.agents.

/** Models offered for each provider; any other model id can be typed in. */
export const MODEL_SUGGESTIONS: Record<AgentRecord['provider'], { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  ],
  openai: [],
  openrouter: [],
}

const common = {
  name: z.string().trim().min(1).max(64),
  about: z.string().trim().max(280).default(''),
  provider: z.enum(['anthropic', 'openai', 'openrouter']),
  model: z
    .string()
    .trim()
    .regex(/^[\w.:/-]{1,100}$/, 'use the provider’s model id, such as claude-opus-5-5'),
  instructions: z.string().max(20_000).default(''),
}

const createAgent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), owner: z.string().trim().min(1), ...common }),
  z.object({
    kind: z.literal('shared'),
    access: z.enum(['allowlist', 'anyone']),
    allowlist: z.array(z.string().trim().min(1)).max(200).default([]),
    ...common,
  }),
])

const updateAgent = z
  .object({
    name: common.name,
    about: z.string().trim().max(280),
    provider: common.provider,
    model: common.model,
    instructions: z.string().max(20_000),
    desiredState: z.enum(['running', 'stopped']),
    access: z.enum(['allowlist', 'anyone']),
    allowlist: z.array(z.string().trim().min(1)).max(200),
  })
  .partial()

const authorize = z.object({ tag: z.union([z.string().min(1), z.array(z.string())]) })

function parsePubkeys(values: string[], what: string): string[] {
  const parsed = values.map((value) => {
    const pubkey = parsePublicKey(value)
    if (!pubkey) throw new ApiProblem(400, 'invalid_pubkey', `${what}: "${value.slice(0, 24)}" is not a public key.`)
    return pubkey
  })
  return [...new Set(parsed)]
}

function runState(agent: AgentRecord, hive: HiveState): string {
  if (agent.ownerKind === 'member' && !agent.authTag) return 'awaiting_authorization'
  if (agent.desiredState === 'stopped') return 'stopped'
  if (!hiveOnline(hive)) return 'host_offline'
  if (!agent.status || Date.now() - new Date(agent.status.reportedAt).getTime() > HIVE_STALE_MS) return 'starting'
  return agent.status.state
}

export function agentRoutes(app: App, ctx: AppContext) {
  const guard = requireSession(ctx)

  async function present(agents: AgentRecord[]) {
    const pubkeys = new Set<string>()
    for (const agent of agents) {
      if (agent.ownerKind === 'member') pubkeys.add(agent.ownerPubkey)
      for (const entry of agent.allowlist) pubkeys.add(entry)
    }
    const profiles = ctx.community ? await ctx.community.profiles([...pubkeys]).catch(() => new Map()) : new Map()
    const person = (pubkey: string) => ({ pubkey, npub: toNpub(pubkey), name: profiles.get(pubkey)?.displayName ?? null })

    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      about: agent.about,
      pubkey: agent.pubkey,
      npub: toNpub(agent.pubkey),
      kind: agent.ownerKind === 'member' ? 'personal' : 'shared',
      owner: agent.ownerKind === 'member' ? person(agent.ownerPubkey) : null,
      access: agent.access,
      allowlist: agent.allowlist.map(person),
      provider: agent.provider,
      model: agent.model,
      instructions: agent.instructions,
      desiredState: agent.desiredState,
      state: runState(agent, ctx.hive),
      status: agent.status?.detail ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    }))
  }

  app.get(`${API}/agents`, guard, async (c) => {
    const store = requireStore(ctx)
    const hosted = await store.agents()
    const hostedPubkeys = new Set(hosted.map((agent) => agent.pubkey))
    // Agents the relay knows about that this console does not host: they run
    // in a member's Buzz app, or on a machine that member operates.
    const known = ctx.community ? await ctx.community.agents().catch(() => []) : []

    return c.json({
      hosted: await present(hosted),
      elsewhere: known
        .filter((agent) => !hostedPubkeys.has(agent.pubkey))
        .map((agent) => ({
          pubkey: agent.pubkey,
          npub: toNpub(agent.pubkey),
          name: agent.displayName,
          about: agent.about,
          owner: { pubkey: agent.owner, npub: toNpub(agent.owner), name: agent.ownerName },
          firstSeenAt: agent.firstSeenAt,
          lastMessageAt: agent.lastMessageAt,
        })),
      host: {
        online: hiveOnline(ctx.hive),
        lastSeenAt: ctx.hive.lastSeenAt ? new Date(ctx.hive.lastSeenAt).toISOString() : null,
        providers: ctx.hive.providers,
      },
      models: MODEL_SUGGESTIONS,
    })
  })

  app.post(`${API}/agents`, guard, async (c) => {
    const store = requireStore(ctx)
    const community = requireCommunity(ctx)
    const { commands } = requireCommands(ctx)
    if (!ctx.box) throw new ApiProblem(503, 'encryption_key_missing', 'The console cannot store agent keys without CONSOLE_ENCRYPTION_KEY.')
    const body = createAgent.parse(await c.req.json())

    const members = await community.members()
    const people = new Map(members.filter((member) => !member.agentOwner).map((member) => [member.pubkey, member]))
    const requireMember = (pubkey: string, what: string) => {
      if (!people.has(pubkey)) throw new ApiProblem(422, 'not_a_member', `${what} must be a member of this community.`)
    }

    const secret = newSecretKeyHex()
    const pubkey = createSigner(parseSecretKey(secret)).pubkey
    const shared = { name: body.name, about: body.about, provider: body.provider, model: body.model, instructions: body.instructions }

    let record: AgentRecord
    if (body.kind === 'personal') {
      const [owner] = parsePubkeys([body.owner], 'Owner')
      requireMember(owner!, 'The owner')
      record = await store.createAgent({
        ...shared,
        pubkey,
        secretSealed: ctx.box.seal(secret, `agent:${pubkey}`),
        ownerKind: 'member',
        ownerPubkey: owner!,
        custodianSecretSealed: null,
        authTag: null,
        access: 'owner',
        allowlist: [],
        createdBy: c.get('session').sub,
      })
    } else {
      const allowlist = body.access === 'allowlist' ? parsePubkeys(body.allowlist, 'Allowlist') : []
      if (body.access === 'allowlist' && allowlist.length === 0) {
        throw new ApiProblem(422, 'empty_allowlist', 'Choose at least one member, or let every member use the agent.')
      }
      for (const entry of allowlist) requireMember(entry, 'Everyone on the allowlist')
      const custodianSecret = newSecretKeyHex()
      const custodian = createSigner(parseSecretKey(custodianSecret))
      record = await store.createAgent({
        ...shared,
        pubkey,
        secretSealed: ctx.box.seal(secret, `agent:${pubkey}`),
        ownerKind: 'community',
        ownerPubkey: custodian.pubkey,
        custodianSecretSealed: ctx.box.seal(custodianSecret, `custodian:${pubkey}`),
        authTag: createAuthTag(custodian, pubkey),
        access: body.access,
        allowlist,
        createdBy: c.get('session').sub,
      })
    }

    // Membership lets the agent connect to an invite-only relay. If the relay
    // refuses, drop the record so a retry starts clean.
    try {
      await commands.addMember(pubkey, 'member')
    } catch (error) {
      await store.deleteAgent(record.id)
      throw error
    }

    ctx.cache.invalidate('community.')
    await store.recordAudit({
      actor: c.get('session').sub,
      action: 'agent.created',
      target: pubkey,
      detail: { name: record.name, kind: body.kind, access: record.access, provider: record.provider, model: record.model },
      clientIp: c.get('clientIp'),
    })
    return c.json((await present([record]))[0], 201)
  })

  app.patch(`${API}/agents/:id`, guard, async (c) => {
    const store = requireStore(ctx)
    const id = z.uuid().parse(c.req.param('id'))
    const existing = await store.agent(id)
    if (!existing) throw new ApiProblem(404, 'agent_not_found', 'No such agent.')
    const body = updateAgent.parse(await c.req.json())

    const changes: Parameters<typeof store.updateAgent>[1] = {
      name: body.name,
      about: body.about,
      provider: body.provider,
      model: body.model,
      instructions: body.instructions,
      desiredState: body.desiredState,
    }
    if (body.access !== undefined || body.allowlist !== undefined) {
      if (existing.ownerKind === 'member') {
        throw new ApiProblem(
          422,
          'personal_agent_access',
          'A personal agent answers its owner only. To let others use it, create a shared agent: those always run on the community host.',
        )
      }
      const access = body.access ?? (existing.access as 'allowlist' | 'anyone')
      const allowlist = access === 'allowlist' ? parsePubkeys(body.allowlist ?? existing.allowlist, 'Allowlist') : []
      if (access === 'allowlist' && allowlist.length === 0) {
        throw new ApiProblem(422, 'empty_allowlist', 'Choose at least one member, or let every member use the agent.')
      }
      changes.access = access
      changes.allowlist = allowlist
    }

    const updated = await store.updateAgent(id, changes)
    if (!updated) throw new ApiProblem(404, 'agent_not_found', 'No such agent.')
    await store.recordAudit({
      actor: c.get('session').sub,
      action: 'agent.updated',
      target: updated.pubkey,
      detail: { fields: Object.keys(body) },
      clientIp: c.get('clientIp'),
    })
    return c.json((await present([updated]))[0])
  })

  // A personal agent starts once its owner has vouched for it. The owner makes
  // the attestation in Buzz (Settings → Security → Authorize external identity)
  // and the operator pastes it here.
  app.post(`${API}/agents/:id/authorization`, guard, async (c) => {
    const store = requireStore(ctx)
    const id = z.uuid().parse(c.req.param('id'))
    const agent = await store.agent(id)
    if (!agent) throw new ApiProblem(404, 'agent_not_found', 'No such agent.')
    if (agent.ownerKind !== 'member') throw new ApiProblem(422, 'not_personal', 'Only personal agents need their owner’s authorization.')

    const { tag } = authorize.parse(await c.req.json())
    const result = verifyAuthTag(tag, agent.pubkey)
    if (!result.ok) throw new ApiProblem(422, 'invalid_authorization', result.reason)
    if (result.owner !== agent.ownerPubkey) {
      throw new ApiProblem(422, 'wrong_owner', 'This authorization was signed by a different identity than the agent’s owner.')
    }
    const updated = await store.updateAgent(id, { authTag: result.tag })
    await store.recordAudit({ actor: c.get('session').sub, action: 'agent.authorized', target: agent.pubkey, clientIp: c.get('clientIp') })
    return c.json((await present([updated!]))[0])
  })

  app.delete(`${API}/agents/:id`, guard, async (c) => {
    const store = requireStore(ctx)
    const id = z.uuid().parse(c.req.param('id'))
    const removed = await store.deleteAgent(id)
    if (!removed) throw new ApiProblem(404, 'agent_not_found', 'No such agent.')
    // The key is gone, so the identity can never connect again; removing its
    // membership is tidying up and must not block the delete.
    let membershipRemoved = true
    try {
      await requireCommands(ctx).commands.removeMember(removed.pubkey)
    } catch (error) {
      membershipRemoved = false
      ctx.log.warn({ component: 'agents', err: error, agent: removed.pubkey }, 'could not remove a deleted agent from the roster')
    }
    ctx.cache.invalidate('community.')
    await store.recordAudit({
      actor: c.get('session').sub,
      action: 'agent.deleted',
      target: removed.pubkey,
      detail: { name: removed.name, membershipRemoved },
      clientIp: c.get('clientIp'),
    })
    return c.json({ membershipRemoved })
  })
}
