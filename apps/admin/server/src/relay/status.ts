import type { RelayClient } from './client.js'

// What the relay reports about itself: the public NIP-11 document, the health
// listener's /_status (cached dependency checks, safe to poll), and the
// Prometheus endpoint. The last two are private ports the gateway never routes.

export interface RelayStatus {
  reachable: boolean
  version: string | null
  build: string | null
  uptimeSeconds: number | null
  /** Postgres and Redis as the relay last sampled them; null when it has not sampled yet. */
  dependencies: { postgres: boolean | null; redis: boolean | null; sampleAgeSeconds: number | null }
  partitionsServingSafe: boolean | null
  /** The relay's own signing key, as advertised to clients. */
  relayPubkey: string | null
  membershipRequired: boolean | null
  error: string | null
}

export interface MetricPoint {
  name: string
  labels: Record<string, string>
  value: number
}

export interface RelayMetrics {
  connections: number | null
  authenticatedConnections: number | null
  subscriptions: number | null
  dbPool: { active: number | null; idle: number | null; max: number | null }
  /** Monotonic counters since the relay started; the collector turns them into rates. */
  counters: {
    eventsStored: number
    eventsRejected: number
    authFailures: number
    httpRequests: number
    httpServerErrors: number
  }
}

async function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/** The relay reports each dependency as a boolean, or as an object with a status in older builds. */
const dependencyUp = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['ok', 'up', 'ready', 'true', 'healthy'].includes(value.toLowerCase())
  if (value && typeof value === 'object' && 'status' in value) return dependencyUp((value as { status: unknown }).status)
  return null
}

export async function readRelayStatus(relay: RelayClient, healthUrl: string | undefined): Promise<RelayStatus> {
  const status: RelayStatus = {
    reachable: false,
    version: null,
    build: null,
    uptimeSeconds: null,
    dependencies: { postgres: null, redis: null, sampleAgeSeconds: null },
    partitionsServingSafe: null,
    relayPubkey: null,
    membershipRequired: null,
    error: null,
  }

  const [nip11, health] = await Promise.allSettled([
    relay.request<Record<string, unknown>>({ path: '/', headers: { Accept: 'application/nostr+json' }, timeoutMs: 4000 }),
    healthUrl ? fetchJson<Record<string, unknown>>(`${healthUrl}/_status`) : Promise.reject(new Error('no health URL configured')),
  ])

  if (nip11.status === 'fulfilled') {
    const document = nip11.value.data
    status.reachable = true
    status.version = typeof document.version === 'string' ? document.version : null
    status.relayPubkey = typeof document.self === 'string' ? document.self : null
    status.membershipRequired = Array.isArray(document.supported_nips) ? document.supported_nips.includes(43) : null
  } else {
    status.error = nip11.reason instanceof Error ? nip11.reason.message : String(nip11.reason)
  }

  if (health.status === 'fulfilled') {
    const body = health.value
    const build = body.build as { source_sha?: string } | undefined
    const dependencies = (body.dependencies ?? {}) as Record<string, unknown>
    const partitions = (body.partition_catalog ?? {}) as Record<string, unknown>
    status.version = typeof body.version === 'string' ? body.version : status.version
    status.build = build?.source_sha ? build.source_sha.slice(0, 7) : null
    status.uptimeSeconds = typeof body.uptime_seconds === 'number' ? body.uptime_seconds : null
    status.dependencies = {
      postgres: dependencyUp(dependencies.postgres),
      redis: dependencyUp(dependencies.redis),
      sampleAgeSeconds: typeof dependencies.sample_age_seconds === 'number' ? dependencies.sample_age_seconds : null,
    }
    status.partitionsServingSafe = typeof partitions.serving_safe === 'boolean' ? partitions.serving_safe : null
  }

  return status
}

/** Parses the Prometheus text exposition format into flat samples. Comments and malformed lines are skipped. */
export function parsePrometheus(text: string): MetricPoint[] {
  const points: MetricPoint[] = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/)
    if (!match) continue
    const value = Number(match[3])
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    if (match[2]) {
      for (const pair of match[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[pair[1]!] = pair[2]!.replace(/\\(.)/g, '$1')
      }
    }
    points.push({ name: match[1]!, labels, value })
  }
  return points
}

export function summarizeMetrics(points: MetricPoint[]): RelayMetrics {
  const named = (name: string) => points.filter((point) => point.name === name)
  const gauge = (name: string) => {
    const series = named(name)
    return series.length ? series.reduce((sum, point) => sum + point.value, 0) : null
  }
  const total = (name: string, where?: (labels: Record<string, string>) => boolean) =>
    named(name)
      .filter((point) => !where || where(point.labels))
      .reduce((sum, point) => sum + point.value, 0)
  const pool = (state: string) => {
    const series = named('buzz_db_pool_connections').filter((point) => point.labels.pool_role === 'writer' && point.labels.state === state)
    return series.length ? series.reduce((sum, point) => sum + point.value, 0) : null
  }
  const poolMax = named('buzz_db_pool_max_connections').find((point) => point.labels.pool_role === 'writer')

  return {
    connections: gauge('buzz_ws_connections_active'),
    authenticatedConnections: gauge('buzz_ws_authenticated_connections_active'),
    subscriptions: gauge('buzz_subscriptions_active'),
    dbPool: { active: pool('active'), idle: pool('idle'), max: poolMax?.value ?? null },
    counters: {
      eventsStored: total('buzz_events_stored_total'),
      eventsRejected: total('buzz_events_rejected_total'),
      authFailures: total('buzz_auth_failures_total'),
      httpRequests: total('http_requests_total'),
      httpServerErrors: total('http_requests_total', (labels) => (labels.code ?? '').startsWith('5')),
    },
  }
}

export async function readRelayMetrics(metricsUrl: string): Promise<RelayMetrics> {
  const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`metrics endpoint answered ${response.status}`)
  return summarizeMetrics(parsePrometheus(await response.text()))
}
