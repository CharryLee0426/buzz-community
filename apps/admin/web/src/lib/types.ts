// Shapes of the console API's responses. The server is the source of truth;
// these mirror apps/admin/server/src/http/routes.

export interface RelayStatus {
  reachable: boolean
  version: string | null
  build: string | null
  uptimeSeconds: number | null
  dependencies: { postgres: boolean | null; redis: boolean | null; sampleAgeSeconds: number | null }
  partitionsServingSafe: boolean | null
  relayPubkey: string | null
  membershipRequired: boolean | null
  error: string | null
}

export interface LiveRelay {
  sampledAt: string
  connections: number | null
  authenticatedConnections: number | null
  subscriptions: number | null
  dbPool: { active: number | null; idle: number | null; max: number | null }
  rates: { eventsStored: number; eventsRejected: number; authFailures: number; httpServerErrors: number } | null
}

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

export interface ServiceInfo {
  id: string
  name: string
  image: string | null
  repo: string | null
  replicas: number | null
  tracingEnabled: boolean
  domains: { domain: string; kind: 'custom' | 'railway'; certificate: string | null }[]
  deployment: { id: string; status: string; createdAt: string; statusUpdatedAt: string | null } | null
}

export interface ServiceUsage extends ServiceInfo {
  cpu: number | null
  memoryGb: number | null
  diskGb: number | null
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
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

export interface Sample {
  name: string
  at: string
  value: number
}

export interface Overview {
  host: string
  generatedAt: string
  relay: RelayStatus
  live: LiveRelay | null
  counts: CommunityCounts | null
  countsError: string | null
  messages: { at: string; messages: number }[]
  samples: Sample[]
  railwayConnected: boolean
  services: ServiceInfo[] | null
  servicesError: string | null
  alerts: { open: number; recent: AlertRecord[] }
}

export interface Member {
  pubkey: string
  npub: string
  role: 'owner' | 'admin' | 'member'
  kind: 'person' | 'agent' | 'console'
  addedBy: string | null
  joinedAt: string
  displayName: string | null
  nip05: string | null
  agentOwner: string | null
  banned: boolean
  mutedUntil: string | null
  lastMessageAt: string | null
  messages30d: number
  hostedAgentId: string | null
}

export interface Invite {
  id: string
  state: 'active' | 'used' | 'expired' | 'revoked'
  url: string | null
  note: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  maxUses: number | null
  useCount: number
  createdBy: string
  createdByName: string | null
  viaConsole: boolean
}

export interface Channel {
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

export interface Person {
  pubkey: string
  npub: string
  name: string | null
}

export type AgentProvider = 'anthropic' | 'openai' | 'openrouter'
export type AgentState =
  | 'awaiting_authorization'
  | 'stopped'
  | 'host_offline'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'failed'
  | 'stopping'

export interface HostedAgent {
  id: string
  name: string
  about: string
  pubkey: string
  npub: string
  kind: 'personal' | 'shared'
  owner: Person | null
  access: 'owner' | 'allowlist' | 'anyone'
  allowlist: Person[]
  provider: AgentProvider
  model: string
  instructions: string
  desiredState: 'running' | 'stopped'
  state: AgentState
  status: { restarts?: number; lastError?: string; startedAt?: string; lastExit?: string } | null
  createdAt: string
  updatedAt: string
}

export interface AgentsResponse {
  hosted: HostedAgent[]
  elsewhere: {
    pubkey: string
    npub: string
    name: string | null
    about: string | null
    owner: Person
    firstSeenAt: string
    lastMessageAt: string | null
  }[]
  host: { online: boolean; lastSeenAt: string | null; providers: Record<string, boolean> }
  models: Record<AgentProvider, { id: string; label: string }[]>
}

export interface Series {
  serviceId: string | null
  measurement: string
  points: { at: number; value: number }[]
}

export interface MetricsResponse {
  hours: number
  /** False until the console has a Railway token; then only relay samples are present. */
  railwayConnected: boolean
  services: { id: string; name: string }[]
  resources: Series[]
  http: {
    service: string
    byStatus: { status: number; points: { at: number; value: number }[] }[]
    latency: { at: number; p50: number; p95: number; p99: number }[]
  } | null
  relay: Sample[]
}

export interface LogLine {
  timestamp: string
  message: string
  severity: string
  service: string | null
  serviceId: string | null
  deploymentId: string | null
  attributes: Record<string, unknown>
}

export interface Deployment {
  id: string
  serviceId: string | null
  service: string
  status: string
  createdAt: string
  statusUpdatedAt: string | null
  source: string | null
  canRollback: boolean
}

export interface Settings {
  community: { host: string; address: string; consolePubkey: string | null; consoleNpub: string | null }
  integrations: {
    database: boolean
    ownerKey: boolean
    encryptionKey: boolean
    railway: boolean
    hive: { tokenConfigured: boolean; online: boolean; lastSeenAt: string | null; providers: Record<string, boolean> }
    webhook: { configured: boolean; url: string | null }
    alertForwarding: boolean
  }
  deployment: { projectId: string | null; environment: string | null; deploymentId: string | null }
  session: { username: string; lifetimeHours: number }
}

export interface AuditEntry {
  id: string
  at: string
  actor: string
  action: string
  target: string | null
  detail: Record<string, unknown>
  clientIp: string | null
}
