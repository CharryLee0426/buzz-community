import type pg from 'pg'

// Read-only views of the relay's tables. Every query filters on community_id
// (the tables are multi-tenant even with one community) and bounds any scan of
// `events` by time so partitions prune. Pubkeys are hex text in some tables and
// 32 raw bytes in others; everything leaves this module as hex.

/** Kinds that count as a message a person would recognize: stream, rich, forum post, forum comment. */
const MESSAGE_KINDS = [9, 40002, 45001, 45003]

export interface CommunityCounts {
  people: number
  admins: number
  agents: number
  openChannels: number
  privateChannels: number
  directMessages: number
  messages24h: number
  activeAuthors24h: number
  pendingInvites: number
}

export interface MemberRow {
  pubkey: string
  role: 'owner' | 'admin' | 'member'
  addedBy: string | null
  joinedAt: string
  displayName: string | null
  nip05: string | null
  avatarUrl: string | null
  /** Set when this identity is an agent: the pubkey of its owner. */
  agentOwner: string | null
  banned: boolean
  mutedUntil: string | null
  lastMessageAt: string | null
  messages30d: number
}

export interface ChannelRow {
  id: string
  name: string
  type: 'stream' | 'forum'
  description: string | null
  createdAt: string
  archivedAt: string | null
  autoJoin: boolean
  members: number
  lastMessageAt: string | null
  messages7d: number
}

export interface KnownAgentRow {
  pubkey: string
  displayName: string | null
  about: string | null
  avatarUrl: string | null
  owner: string
  ownerName: string | null
  channelAddPolicy: 'anyone' | 'owner_only' | 'nobody'
  firstSeenAt: string
  isMember: boolean
  lastMessageAt: string | null
}

export interface InviteRow {
  id: string
  tokenHash: string
  createdBy: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  maxUses: number | null
  useCount: number
}

export interface CommunityStore {
  /** The community's id, or null when the relay has not created it yet. */
  communityId(): Promise<string | null>
  /** `excludePubkey` keeps the console's own owner key out of the people count. */
  /** `hostedAgents` are public keys the console runs as agents, counted as agents whatever the relay thinks. */
  counts(excludePubkey?: string, hostedAgents?: string[]): Promise<CommunityCounts>
  members(): Promise<MemberRow[]>
  channels(): Promise<ChannelRow[]>
  agents(): Promise<KnownAgentRow[]>
  invites(): Promise<InviteRow[]>
  messageSeries(hours: number): Promise<{ at: string; messages: number }[]>
  profiles(pubkeys: string[]): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>>
}

const iso = (value: Date | null) => (value ? value.toISOString() : null)

export function createCommunityStore(pool: pg.Pool, communityHost: string): CommunityStore {
  let cachedId: string | null = null

  async function communityId() {
    if (cachedId) return cachedId
    const { rows } = await pool.query<{ id: string }>(
      `select id from communities where lower(host) = lower($1) and deletion_state = 'active'`,
      [communityHost],
    )
    cachedId = rows[0]?.id ?? null
    return cachedId
  }

  async function requireId() {
    const id = await communityId()
    if (!id) throw new Error(`The relay has no community for ${communityHost} yet.`)
    return id
  }

  return {
    communityId,

    async counts(excludePubkey, hostedAgents = []) {
      const id = await requireId()
      // The relay knows an agent by the owner it authenticated with. An agent
      // hosted here for several members has a custodian for an owner, which is
      // not a member, so the relay sees it as an ordinary member; the console
      // knows better and says which those are.
      const { rows } = await pool.query(
        `with agents as (
           select encode(pubkey, 'hex') as pubkey from users
           where community_id = $1 and agent_owner_pubkey is not null and deactivated_at is null
           union
           select m.pubkey from relay_members m where m.community_id = $1 and m.pubkey = any($4::text[])
         )
         select
           (select count(*) from relay_members m
              where m.community_id = $1 and m.pubkey is distinct from $3
                and not exists (select 1 from agents a where a.pubkey = m.pubkey))::int as people,
           (select count(*) from relay_members m
              where m.community_id = $1 and m.role in ('owner', 'admin') and m.pubkey is distinct from $3)::int as admins,
           (select count(*) from agents)::int as agents,
           (select count(*) from channels where community_id = $1 and deleted_at is null and archived_at is null
              and channel_type in ('stream', 'forum') and visibility = 'open')::int as open_channels,
           (select count(*) from channels where community_id = $1 and deleted_at is null and archived_at is null
              and channel_type in ('stream', 'forum') and visibility = 'private')::int as private_channels,
           (select count(*) from channels where community_id = $1 and deleted_at is null
              and channel_type = 'dm')::int as direct_messages,
           (select count(*) from events where community_id = $1 and created_at >= now() - interval '24 hours'
              and deleted_at is null and kind = any($2))::int as messages_24h,
           (select count(distinct pubkey) from events where community_id = $1
              and created_at >= now() - interval '24 hours' and kind = any($2))::int as active_authors_24h,
           (select count(*) from relay_invites where community_id = $1 and revoked_at is null and expires_at > now()
              and (max_uses is null or use_count < max_uses))::int as pending_invites`,
        [id, MESSAGE_KINDS, excludePubkey ?? null, hostedAgents],
      )
      const row = rows[0]
      return {
        people: row.people,
        admins: row.admins,
        agents: row.agents,
        openChannels: row.open_channels,
        privateChannels: row.private_channels,
        directMessages: row.direct_messages,
        messages24h: row.messages_24h,
        activeAuthors24h: row.active_authors_24h,
        pendingInvites: row.pending_invites,
      }
    },

    async members() {
      const id = await requireId()
      const { rows } = await pool.query(
        `with activity as (
           select pubkey, max(created_at) as last_message_at, count(*)::int as messages_30d
           from events
           where community_id = $1 and created_at >= now() - interval '30 days'
             and deleted_at is null and kind = any($2)
           group by pubkey
         )
         select m.pubkey, m.role, m.added_by, m.created_at,
                u.display_name, u.nip05_handle, u.avatar_url,
                encode(u.agent_owner_pubkey, 'hex') as agent_owner,
                coalesce(b.banned and (b.ban_expires_at is null or b.ban_expires_at > now()), false) as banned,
                case when b.muted_until > now() then b.muted_until end as muted_until,
                a.last_message_at, coalesce(a.messages_30d, 0) as messages_30d
         from relay_members m
         left join users u on u.community_id = m.community_id and u.pubkey = decode(m.pubkey, 'hex')
         left join community_bans b on b.community_id = m.community_id and b.pubkey = decode(m.pubkey, 'hex')
         left join activity a on a.pubkey = decode(m.pubkey, 'hex')
         where m.community_id = $1
         order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at`,
        [id, MESSAGE_KINDS],
      )
      return rows.map((row) => ({
        pubkey: row.pubkey,
        role: row.role,
        addedBy: row.added_by,
        joinedAt: row.created_at.toISOString(),
        displayName: row.display_name,
        nip05: row.nip05_handle,
        avatarUrl: row.avatar_url,
        agentOwner: row.agent_owner,
        banned: row.banned,
        mutedUntil: iso(row.muted_until),
        lastMessageAt: iso(row.last_message_at),
        messages30d: row.messages_30d,
      }))
    },

    // Open channels only. Private channels and direct messages are counted on
    // the overview but never listed: their names are not the operator's to read.
    async channels() {
      const id = await requireId()
      const { rows } = await pool.query(
        `with activity as (
           select channel_id, max(created_at) as last_message_at,
                  count(*) filter (where created_at >= now() - interval '7 days')::int as messages_7d
           from events
           where community_id = $1 and created_at >= now() - interval '30 days'
             and deleted_at is null and channel_id is not null and kind = any($2)
           group by channel_id
         ),
         membership as (
           select channel_id, count(*)::int as members
           from channel_members where community_id = $1 and removed_at is null
           group by channel_id
         )
         select c.id, c.name, c.channel_type, c.description, c.created_at, c.archived_at, c.auto_join,
                coalesce(m.members, 0) as members, a.last_message_at, coalesce(a.messages_7d, 0) as messages_7d
         from channels c
         left join activity a on a.channel_id = c.id
         left join membership m on m.channel_id = c.id
         where c.community_id = $1 and c.deleted_at is null
           and c.channel_type in ('stream', 'forum') and c.visibility = 'open'
         order by c.archived_at is not null, lower(c.name)`,
        [id, MESSAGE_KINDS],
      )
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.channel_type,
        description: row.description,
        createdAt: row.created_at.toISOString(),
        archivedAt: iso(row.archived_at),
        autoJoin: row.auto_join,
        members: row.members,
        lastMessageAt: iso(row.last_message_at),
        messages7d: row.messages_7d,
      }))
    },

    // Every identity the relay has verified as an agent, wherever it runs.
    async agents() {
      const id = await requireId()
      const { rows } = await pool.query(
        `with activity as (
           select pubkey, max(created_at) as last_message_at
           from events
           where community_id = $1 and created_at >= now() - interval '30 days'
             and deleted_at is null and kind = any($2)
           group by pubkey
         )
         select encode(u.pubkey, 'hex') as pubkey, u.display_name, u.about, u.avatar_url,
                encode(u.agent_owner_pubkey, 'hex') as owner, o.display_name as owner_name,
                u.channel_add_policy::text as channel_add_policy, u.created_at,
                exists (select 1 from relay_members m
                        where m.community_id = u.community_id and m.pubkey = encode(u.pubkey, 'hex')) as is_member,
                a.last_message_at
         from users u
         left join users o on o.community_id = u.community_id and o.pubkey = u.agent_owner_pubkey
         left join activity a on a.pubkey = u.pubkey
         where u.community_id = $1 and u.agent_owner_pubkey is not null and u.deactivated_at is null
         order by lower(coalesce(u.display_name, '')), u.created_at`,
        [id, MESSAGE_KINDS],
      )
      return rows.map((row) => ({
        pubkey: row.pubkey,
        displayName: row.display_name,
        about: row.about,
        avatarUrl: row.avatar_url,
        owner: row.owner,
        ownerName: row.owner_name,
        channelAddPolicy: row.channel_add_policy,
        firstSeenAt: row.created_at.toISOString(),
        isMember: row.is_member,
        lastMessageAt: iso(row.last_message_at),
      }))
    },

    async invites() {
      const id = await requireId()
      const { rows } = await pool.query(
        `select id, encode(token_hash, 'hex') as token_hash, created_by, created_at, expires_at, revoked_at, max_uses, use_count
         from relay_invites
         where community_id = $1 and created_at >= now() - interval '90 days'
         order by created_at desc
         limit 200`,
        [id],
      )
      return rows.map((row) => ({
        id: row.id,
        tokenHash: row.token_hash,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: iso(row.revoked_at),
        maxUses: row.max_uses,
        useCount: row.use_count,
      }))
    },

    async messageSeries(hours) {
      const id = await requireId()
      const bucket = hours <= 48 ? 'hour' : 'day'
      const { rows } = await pool.query(
        `select b.at, coalesce(e.messages, 0)::int as messages
         from generate_series(
                date_trunc($3, now() - make_interval(hours => $4)),
                date_trunc($3, now()),
                ('1 ' || $3)::interval
              ) as b(at)
         left join (
           select date_trunc($3, created_at) as at, count(*) as messages
           from events
           where community_id = $1 and created_at >= date_trunc($3, now() - make_interval(hours => $4))
             and deleted_at is null and kind = any($2)
           group by 1
         ) e on e.at = b.at
         order by b.at`,
        [id, MESSAGE_KINDS, bucket, hours],
      )
      return rows.map((row) => ({ at: row.at.toISOString(), messages: row.messages }))
    },

    async profiles(pubkeys) {
      const found = new Map<string, { displayName: string | null; avatarUrl: string | null }>()
      if (pubkeys.length === 0) return found
      const id = await requireId()
      const { rows } = await pool.query(
        `select encode(pubkey, 'hex') as pubkey, display_name, avatar_url
         from users where community_id = $1 and pubkey = any($2)`,
        [id, pubkeys.map((pubkey) => Buffer.from(pubkey, 'hex'))],
      )
      for (const row of rows) found.set(row.pubkey, { displayName: row.display_name, avatarUrl: row.avatar_url })
      return found
    },
  }
}
