import type pg from 'pg'
import type { AuthTag } from '../nostr/attestation.js'

// The console's own state, in the `console` schema: the invite links it minted,
// its audit trail, incoming alerts, hosted agents, and a short metric history.

export interface AuditEntry {
  id: string
  at: string
  actor: string
  action: string
  target: string | null
  detail: Record<string, unknown>
  clientIp: string | null
}

export type AlertSeverity = 'critical' | 'warning' | 'notice' | 'info'

export interface AlertRecord {
  id: string
  receivedAt: string
  source: string
  type: string
  severity: AlertSeverity
  service: string | null
  environment: string | null
  summary: string
  payload: Record<string, unknown>
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

export type AgentAccess = 'owner' | 'allowlist' | 'anyone'
export type AgentProvider = 'anthropic' | 'openai' | 'openrouter'

export interface AgentRecord {
  id: string
  name: string
  about: string
  pubkey: string
  secretSealed: string
  ownerKind: 'member' | 'community'
  ownerPubkey: string
  custodianSecretSealed: string | null
  authTag: AuthTag | null
  access: AgentAccess
  allowlist: string[]
  provider: AgentProvider
  model: string
  instructions: string
  desiredState: 'running' | 'stopped'
  createdBy: string
  createdAt: string
  updatedAt: string
  status: { state: string; reportedAt: string; detail: Record<string, unknown> } | null
}

export type NewAgent = Omit<AgentRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'desiredState'>
export type AgentChanges = Partial<
  Pick<AgentRecord, 'name' | 'about' | 'access' | 'allowlist' | 'provider' | 'model' | 'instructions' | 'desiredState' | 'authTag'>
>

export interface ConsoleStore {
  recordAudit(entry: { actor: string; action: string; target?: string; detail?: Record<string, unknown>; clientIp?: string }): Promise<void>
  auditLog(limit: number): Promise<AuditEntry[]>

  saveInvite(invite: { tokenHash: string; linkSealed: string; note: string; createdBy: string }): Promise<void>
  savedInvites(): Promise<Map<string, { linkSealed: string; note: string; createdBy: string }>>
  /** Marks a relay invite revoked. Returns false when it was already revoked or does not exist. */
  revokeInvite(communityId: string, inviteId: string): Promise<boolean>

  addAlert(alert: Omit<AlertRecord, 'id' | 'receivedAt' | 'acknowledgedAt' | 'acknowledgedBy'>): Promise<void>
  alerts(options: { limit: number; openOnly?: boolean }): Promise<AlertRecord[]>
  openAlertCount(): Promise<number>
  acknowledgeAlert(id: string, actor: string): Promise<boolean>

  agents(): Promise<AgentRecord[]>
  agent(id: string): Promise<AgentRecord | null>
  createAgent(agent: NewAgent): Promise<AgentRecord>
  updateAgent(id: string, changes: AgentChanges): Promise<AgentRecord | null>
  deleteAgent(id: string): Promise<AgentRecord | null>
  reportAgentStatus(reports: { agentId: string; state: string; detail: Record<string, unknown> }[]): Promise<void>

  recordSamples(samples: { name: string; value: number }[]): Promise<void>
  samples(names: string[], sinceHours: number): Promise<{ name: string; at: string; value: number }[]>
  pruneSamples(olderThanDays: number): Promise<void>
}

const AGENT_COLUMNS = `a.id, a.name, a.about, a.pubkey, a.secret_sealed, a.owner_kind, a.owner_pubkey,
  a.custodian_secret_sealed, a.auth_tag, a.access, a.allowlist, a.provider, a.model, a.instructions,
  a.desired_state, a.created_by, a.created_at, a.updated_at,
  s.state as status_state, s.reported_at as status_reported_at, s.detail as status_detail`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAgent(row: any): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    about: row.about,
    pubkey: row.pubkey,
    secretSealed: row.secret_sealed,
    ownerKind: row.owner_kind,
    ownerPubkey: row.owner_pubkey,
    custodianSecretSealed: row.custodian_secret_sealed,
    authTag: row.auth_tag,
    access: row.access,
    allowlist: row.allowlist,
    provider: row.provider,
    model: row.model,
    instructions: row.instructions,
    desiredState: row.desired_state,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    status: row.status_state
      ? { state: row.status_state, reportedAt: row.status_reported_at.toISOString(), detail: row.status_detail ?? {} }
      : null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAlert(row: any): AlertRecord {
  return {
    id: String(row.id),
    receivedAt: row.received_at.toISOString(),
    source: row.source,
    type: row.type,
    severity: row.severity,
    service: row.service,
    environment: row.environment,
    summary: row.summary,
    payload: row.payload,
    acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
    acknowledgedBy: row.acknowledged_by,
  }
}

const AGENT_FIELDS: Record<keyof AgentChanges, string> = {
  name: 'name',
  about: 'about',
  access: 'access',
  allowlist: 'allowlist',
  provider: 'provider',
  model: 'model',
  instructions: 'instructions',
  desiredState: 'desired_state',
  authTag: 'auth_tag',
}

export function createConsoleStore(pool: pg.Pool): ConsoleStore {
  const agentById = async (id: string) => {
    const { rows } = await pool.query(
      `select ${AGENT_COLUMNS} from agents a left join agent_status s on s.agent_id = a.id where a.id = $1`,
      [id],
    )
    return rows[0] ? toAgent(rows[0]) : null
  }

  return {
    async recordAudit({ actor, action, target, detail, clientIp }) {
      await pool.query('insert into audit_log (actor, action, target, detail, client_ip) values ($1, $2, $3, $4, $5)', [
        actor,
        action,
        target ?? null,
        JSON.stringify(detail ?? {}),
        clientIp ?? null,
      ])
    },

    async auditLog(limit) {
      const { rows } = await pool.query('select * from audit_log order by at desc, id desc limit $1', [limit])
      return rows.map((row) => ({
        id: String(row.id),
        at: row.at.toISOString(),
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: row.detail,
        clientIp: row.client_ip,
      }))
    },

    async saveInvite({ tokenHash, linkSealed, note, createdBy }) {
      await pool.query(
        `insert into invites (token_hash, link_sealed, note, created_by) values (decode($1, 'hex'), $2, $3, $4)
         on conflict (token_hash) do nothing`,
        [tokenHash, linkSealed, note, createdBy],
      )
    },

    async savedInvites() {
      const { rows } = await pool.query(
        `select encode(token_hash, 'hex') as token_hash, link_sealed, note, created_by
         from invites where created_at >= now() - interval '120 days'`,
      )
      return new Map(rows.map((row) => [row.token_hash, { linkSealed: row.link_sealed, note: row.note, createdBy: row.created_by }]))
    },

    // The relay has no revoke call; this is the statement the relay itself runs
    // when it revokes an invite, and its claim path honors the column.
    async revokeInvite(communityId, inviteId) {
      const { rowCount } = await pool.query(
        `update public.relay_invites set revoked_at = clock_timestamp()
         where community_id = $1 and id = $2 and revoked_at is null`,
        [communityId, inviteId],
      )
      return (rowCount ?? 0) > 0
    },

    async addAlert({ source, type, severity, service, environment, summary, payload }) {
      await pool.query(
        // Routine events (a deploy that succeeded) are history, not something
        // to act on, so they arrive already acknowledged.
        `insert into alerts (source, type, severity, service, environment, summary, payload, acknowledged_at, acknowledged_by)
         values ($1, $2, $3, $4, $5, $6, $7,
                 case when $3 in ('info', 'notice') then now() end,
                 case when $3 in ('info', 'notice') then 'auto' end)`,
        [source, type, severity, service, environment, summary, JSON.stringify(payload)],
      )
    },

    async alerts({ limit, openOnly }) {
      const { rows } = await pool.query(
        `select * from alerts ${openOnly ? 'where acknowledged_at is null' : ''} order by received_at desc, id desc limit $1`,
        [limit],
      )
      return rows.map(toAlert)
    },

    async openAlertCount() {
      const { rows } = await pool.query(`select count(*)::int as open from alerts where acknowledged_at is null`)
      return rows[0].open
    },

    async acknowledgeAlert(id, actor) {
      const { rowCount } = await pool.query(
        `update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1 and acknowledged_at is null`,
        [id, actor],
      )
      return (rowCount ?? 0) > 0
    },

    async agents() {
      const { rows } = await pool.query(
        `select ${AGENT_COLUMNS} from agents a left join agent_status s on s.agent_id = a.id order by lower(a.name), a.created_at`,
      )
      return rows.map(toAgent)
    },

    agent: agentById,

    async createAgent(agent) {
      const { rows } = await pool.query(
        `insert into agents (name, about, pubkey, secret_sealed, owner_kind, owner_pubkey, custodian_secret_sealed,
                             auth_tag, access, allowlist, provider, model, instructions, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning id`,
        [
          agent.name,
          agent.about,
          agent.pubkey,
          agent.secretSealed,
          agent.ownerKind,
          agent.ownerPubkey,
          agent.custodianSecretSealed,
          agent.authTag ? JSON.stringify(agent.authTag) : null,
          agent.access,
          agent.allowlist,
          agent.provider,
          agent.model,
          agent.instructions,
          agent.createdBy,
        ],
      )
      return (await agentById(rows[0].id))!
    },

    async updateAgent(id, changes) {
      const sets: string[] = []
      const values: unknown[] = [id]
      for (const [key, column] of Object.entries(AGENT_FIELDS) as [keyof AgentChanges, string][]) {
        if (changes[key] === undefined) continue
        values.push(key === 'authTag' ? JSON.stringify(changes[key]) : changes[key])
        sets.push(`${column} = $${values.length}`)
      }
      if (sets.length > 0) {
        const { rowCount } = await pool.query(`update agents set ${sets.join(', ')}, updated_at = now() where id = $1`, values)
        if (!rowCount) return null
      }
      return agentById(id)
    },

    async deleteAgent(id) {
      const existing = await agentById(id)
      if (!existing) return null
      await pool.query('delete from agents where id = $1', [id])
      return existing
    },

    async reportAgentStatus(reports) {
      if (reports.length === 0) return
      await pool.query(
        `insert into agent_status (agent_id, state, detail, reported_at)
         select r.agent_id, r.state, r.detail, now()
         from jsonb_to_recordset($1::jsonb) as r(agent_id uuid, state text, detail jsonb)
         where exists (select 1 from agents a where a.id = r.agent_id)
         on conflict (agent_id) do update set state = excluded.state, detail = excluded.detail, reported_at = excluded.reported_at`,
        [JSON.stringify(reports.map((report) => ({ agent_id: report.agentId, state: report.state, detail: report.detail })))],
      )
    },

    async recordSamples(samples) {
      if (samples.length === 0) return
      await pool.query(
        `insert into metric_samples (name, at, value)
         select s.name, date_trunc('minute', now()), s.value
         from jsonb_to_recordset($1::jsonb) as s(name text, value double precision)
         on conflict (name, at) do update set value = excluded.value`,
        [JSON.stringify(samples)],
      )
    },

    async samples(names, sinceHours) {
      const { rows } = await pool.query(
        `select name, at, value from metric_samples
         where name = any($1) and at >= now() - make_interval(hours => $2)
         order by at`,
        [names, sinceHours],
      )
      return rows.map((row) => ({ name: row.name, at: row.at.toISOString(), value: row.value }))
    },

    async pruneSamples(olderThanDays) {
      await pool.query(`delete from metric_samples where at < now() - make_interval(days => $1)`, [olderThanDays])
    },
  }
}
