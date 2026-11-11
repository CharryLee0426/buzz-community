// What the console asks the host to run, and the pure decisions made from it.

export type Provider = 'anthropic' | 'openai' | 'openrouter'
export type RespondTo = 'owner-only' | 'allowlist' | 'anyone'

/** One hosted agent, as `GET /internal/hive/desired` describes it. */
export interface AgentSpec {
  id: string
  name: string
  about: string
  pubkey: string
  secretKey: string
  /** The NIP-OA owner attestation, as the JSON array buzz-acp reads from BUZZ_AUTH_TAG. */
  authTag: string
  ownerPubkey: string
  respondTo: RespondTo
  allowlist: string[]
  addPolicy: 'owner_only' | 'anyone'
  provider: Provider
  model: string
  instructions: string
  /** Changes whenever anything the process depends on changes. */
  revision: string
}

const HEX_64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function text(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new Error(`agent ${name} is missing or too long`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, name: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`agent ${name} must be one of ${choices.join(', ')}`)
  return value as T
}

/**
 * Checks a response from the console before any of it reaches a process's
 * environment. One malformed agent is skipped and named; the rest still run.
 */
export function parseDesired(body: unknown): { agents: AgentSpec[]; rejected: { id: string; reason: string }[] } {
  const list = (body as { agents?: unknown } | null)?.agents
  if (!Array.isArray(list)) throw new Error('the console did not return a list of agents')

  const agents: AgentSpec[] = []
  const rejected: { id: string; reason: string }[] = []
  for (const entry of list) {
    const raw = (entry ?? {}) as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : 'unknown'
    try {
      if (!UUID.test(id)) throw new Error('agent id is not a UUID')
      const allowlist = Array.isArray(raw.allowlist) ? raw.allowlist : []
      if (!allowlist.every((value) => typeof value === 'string' && HEX_64.test(value))) throw new Error('agent allowlist holds a value that is not a public key')
      const pubkey = text(raw.pubkey, 'pubkey', 64)
      const secretKey = text(raw.secretKey, 'secretKey', 64)
      const ownerPubkey = text(raw.ownerPubkey, 'ownerPubkey', 64)
      if (!HEX_64.test(pubkey) || !HEX_64.test(secretKey) || !HEX_64.test(ownerPubkey)) throw new Error('agent keys must be 64 hex characters')
      const model = text(raw.model, 'model', 100)
      if (!/^[\w.:/-]+$/.test(model)) throw new Error('agent model has characters a model id cannot contain')
      agents.push({
        id,
        name: text(raw.name, 'name', 64),
        about: text(raw.about, 'about', 280, true),
        pubkey,
        secretKey,
        authTag: text(raw.authTag, 'authTag', 2000),
        ownerPubkey,
        respondTo: oneOf(raw.respondTo, 'respondTo', ['owner-only', 'allowlist', 'anyone'] as const),
        allowlist: allowlist as string[],
        addPolicy: oneOf(raw.addPolicy, 'addPolicy', ['owner_only', 'anyone'] as const),
        provider: oneOf(raw.provider, 'provider', ['anthropic', 'openai', 'openrouter'] as const),
        model,
        instructions: text(raw.instructions, 'instructions', 20_000, true),
        revision: text(raw.revision, 'revision', 64),
      })
    } catch (error) {
      rejected.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { agents, rejected }
}

export interface Plan {
  start: AgentSpec[]
  /** Running, but with a different revision than the console now describes. */
  restart: AgentSpec[]
  stop: string[]
}

/** What has to change so the running set matches the desired one. */
export function plan(desired: AgentSpec[], running: ReadonlyMap<string, { revision: string }>): Plan {
  const wanted = new Map(desired.map((agent) => [agent.id, agent]))
  const result: Plan = { start: [], restart: [], stop: [] }
  for (const agent of desired) {
    const current = running.get(agent.id)
    if (!current) result.start.push(agent)
    else if (current.revision !== agent.revision) result.restart.push(agent)
  }
  for (const id of running.keys()) {
    if (!wanted.has(id)) result.stop.push(id)
  }
  return result
}

/** After this many exits in a row without a healthy stretch, an agent is reported as failed. */
export const FAILED_AFTER = 6
const FAILED_RETRY_SECONDS = 600

/** How long to wait before starting an agent again after its nth consecutive early exit. */
export function backoffSeconds(failures: number): number {
  if (failures >= FAILED_AFTER) return FAILED_RETRY_SECONDS
  return Math.min(300, 2 ** Math.max(1, failures))
}

export interface AgentEnvironment {
  relayUrl: string
  home: string
  user: string
  /** Loopback address of this host's model proxy, without a trailing slash. */
  proxyUrl: string
  /** Stands in for a provider key; only the proxy accepts it. */
  proxyToken: string
}

/**
 * The whole environment of one agent process. Built from nothing, not copied
 * from this process, so the operator's provider keys and the console token
 * cannot leak into a process that runs shell commands a chat message asked for.
 */
export function buildAgentEnv(spec: AgentSpec, host: AgentEnvironment): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: host.home,
    USER: host.user,
    LOGNAME: host.user,
    LANG: 'C.UTF-8',
    TMPDIR: `${host.home}/.tmp`,
    RUST_LOG: 'buzz_acp=info',

    BUZZ_RELAY_URL: host.relayUrl,
    BUZZ_PRIVATE_KEY: spec.secretKey,
    BUZZ_AUTH_TAG: spec.authTag,

    BUZZ_ACP_AGENT_COMMAND: 'buzz-agent',
    // buzz-agent has no tools of its own; this gives it the shell and the buzz CLI it replies with.
    BUZZ_ACP_MCP_COMMAND: 'buzz-dev-mcp',
    BUZZ_ACP_DISPLAY_NAME: spec.name,
    BUZZ_ACP_RESPOND_TO: spec.respondTo,
    // Refuse to start if anything widens who the agent answers beyond what the console asked for.
    BUZZ_ACP_ALLOWED_RESPOND_TO: spec.respondTo,
    // A shared agent serves several channels at once; a personal one has a single conversation partner.
    BUZZ_ACP_AGENTS: spec.respondTo === 'owner-only' ? '1' : '2',

    BUZZ_AGENT_PROVIDER: spec.provider,
  }
  if (spec.respondTo === 'allowlist') env.BUZZ_ACP_RESPOND_TO_ALLOWLIST = spec.allowlist.join(',')
  if (spec.instructions.trim()) env.BUZZ_ACP_SYSTEM_PROMPT = spec.instructions
  // Activity frames go to the owner's Buzz app. A shared agent's owner is a custodian key nobody signs in with.
  if (spec.respondTo === 'owner-only') env.BUZZ_ACP_RELAY_OBSERVER = 'true'

  switch (spec.provider) {
    case 'anthropic':
      env.ANTHROPIC_API_KEY = host.proxyToken
      env.ANTHROPIC_MODEL = spec.model
      env.ANTHROPIC_BASE_URL = `${host.proxyUrl}/anthropic`
      break
    case 'openai':
      env.OPENAI_COMPAT_API_KEY = host.proxyToken
      env.OPENAI_COMPAT_MODEL = spec.model
      env.OPENAI_COMPAT_BASE_URL = `${host.proxyUrl}/openai`
      break
    case 'openrouter':
      env.OPENROUTER_API_KEY = host.proxyToken
      env.OPENROUTER_MODEL = spec.model
      env.OPENROUTER_BASE_URL = `${host.proxyUrl}/openrouter`
      break
  }
  return env
}

/** Removes an agent's secrets from a line before it is logged or reported. */
export function redact(line: string, secrets: string[]): string {
  let result = line
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]')
  }
  // A secret key in its bech32 form, which buzz-acp hands to its tools.
  return result.replace(/nsec1[02-9ac-hj-np-z]{20,}/g, '[redacted]')
}
