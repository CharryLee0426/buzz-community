import type { Provider } from './spec.js'

export interface ProviderConfig {
  /** The operator's key. Stays in this process; agents never see it. */
  apiKey: string | undefined
  /** Where requests are forwarded. */
  baseUrl: string
  /** The variable an operator sets to supply the key, named in error messages. */
  variable: string
}

export interface Config {
  host: string
  port: number
  proxyPort: number
  adminUrl: string
  hiveToken: string
  relayUrl: string
  pollSeconds: number
  stopTimeoutSeconds: number
  homeRoot: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  providers: Record<Provider, ProviderConfig>
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`)
  }
  return value
}

function url(env: Env, name: string, fallback: string, protocols: string[]): string {
  const raw = env[name]?.trim() || fallback
  if (!raw) throw new Error(`${name} is required`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} is not a URL`)
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} must start with ${protocols.map((p) => `${p}//`).join(' or ')}`)
  return raw.replace(/\/+$/, '')
}

const optional = (env: Env, name: string) => env[name]?.trim() || undefined

export function loadConfig(env: Env): Config {
  const level = (env.LOG_LEVEL ?? 'info').toLowerCase()
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
    throw new Error('LOG_LEVEL must be debug, info, warn or error')
  }
  return {
    host: env.HOST?.trim() || '::',
    port: integer(env, 'PORT', 8790, 1, 65535),
    proxyPort: integer(env, 'PROXY_PORT', 8791, 1, 65535),
    adminUrl: url(env, 'ADMIN_URL', '', ['http:', 'https:']),
    hiveToken: required(env, 'HIVE_TOKEN'),
    // Agents connect by the community's public name: the relay binds a
    // connection to its community by that hostname.
    relayUrl: url(env, 'BUZZ_RELAY_URL', '', ['ws:', 'wss:']),
    pollSeconds: integer(env, 'POLL_SECONDS', 15, 2, 600),
    stopTimeoutSeconds: integer(env, 'STOP_TIMEOUT_SECONDS', 65, 1, 600),
    homeRoot: env.AGENT_HOME_ROOT?.trim() || '/home/agents',
    logLevel: level,
    providers: {
      anthropic: {
        apiKey: optional(env, 'ANTHROPIC_API_KEY'),
        baseUrl: url(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com', ['http:', 'https:']),
        variable: 'ANTHROPIC_API_KEY',
      },
      openai: {
        apiKey: optional(env, 'OPENAI_API_KEY'),
        baseUrl: url(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1', ['http:', 'https:']),
        variable: 'OPENAI_API_KEY',
      },
      openrouter: {
        apiKey: optional(env, 'OPENROUTER_API_KEY'),
        baseUrl: url(env, 'OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1', ['http:', 'https:']),
        variable: 'OPENROUTER_API_KEY',
      },
    },
  }
}
