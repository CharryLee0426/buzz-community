// Read-only client for Railway's public GraphQL API. The console uses it to
// show what Railway already collects for this environment: deployments, logs,
// resource metrics and edge HTTP metrics. Nothing here changes infrastructure.

const ENDPOINT = 'https://backboard.railway.com/graphql/v2'

export class RailwayError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
    this.name = 'RailwayError'
  }
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

export interface DeploymentInfo {
  id: string
  serviceId: string | null
  service: string
  status: string
  createdAt: string
  statusUpdatedAt: string | null
  /** What produced it: an image tag, a commit, or a CLI upload message. */
  source: string | null
  canRollback: boolean
}

export interface LogLine {
  timestamp: string
  message: string
  severity: string
  serviceId: string | null
  deploymentId: string | null
  attributes: Record<string, unknown>
}

export interface Series {
  serviceId: string | null
  measurement: string
  points: { at: number; value: number }[]
}

export interface HttpTraffic {
  byStatus: { status: number; points: { at: number; value: number }[] }[]
  latency: { at: number; p50: number; p95: number; p99: number }[]
}

export interface RailwayClient {
  services(): Promise<ServiceInfo[]>
  deployments(limit: number): Promise<DeploymentInfo[]>
  logs(options: { serviceId?: string; filter?: string; limit: number; before?: string }): Promise<LogLine[]>
  resourceMetrics(hours: number): Promise<Series[]>
  httpTraffic(serviceId: string, hours: number): Promise<HttpTraffic>
}

type AuthMode = 'project' | 'bearer'

/** Picks a step so a window renders as roughly 120 points whatever its length. */
export function stepSecondsFor(hours: number): number {
  const target = (hours * 3600) / 120
  for (const step of [60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]) {
    if (step >= target) return step
  }
  return 86400
}

export function createRailwayClient(options: { token: string; projectId: string; environmentId: string }): RailwayClient {
  const { token, projectId, environmentId } = options
  // A project token and an account or workspace token authenticate with
  // different headers. Which kind this is gets settled on the first call.
  let mode: AuthMode | undefined

  async function post<T>(authMode: AuthMode, query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authMode === 'project' ? { 'Project-Access-Token': token } : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (cause) {
      throw new RailwayError(`Railway's API could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response.status === 429) {
      throw new RailwayError('Railway is rate-limiting this token. Data will return once the limit resets.', 429)
    }
    const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
    if (!body) throw new RailwayError(`Railway's API answered ${response.status} without a readable body.`)
    if (body.errors?.length) {
      const message = body.errors.map((error) => error.message).join('; ')
      throw new RailwayError(/not authorized|not found/i.test(message) ? `Railway refused the request: ${message}` : message, 502)
    }
    return body.data as T
  }

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (mode) return post<T>(mode, query, variables)
    try {
      const data = await post<T>('project', query, variables)
      mode = 'project'
      return data
    } catch (projectError) {
      try {
        const data = await post<T>('bearer', query, variables)
        mode = 'bearer'
        return data
      } catch {
        throw projectError
      }
    }
  }

  const since = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

  return {
    async services() {
      const data = await gql<{
        environment: {
          serviceInstances: {
            edges: {
              node: {
                serviceId: string
                serviceName: string
                numReplicas: number | null
                tracingEnabled: boolean
                source: { image: string | null; repo: string | null } | null
                latestDeployment: { id: string; status: string; createdAt: string; statusUpdatedAt: string | null } | null
                domains: {
                  serviceDomains: { domain: string }[]
                  customDomains: { domain: string; status: { certificateStatus: string | null } | null }[]
                }
              }
            }[]
          }
        }
      }>(
        `query Services($environmentId: String!) {
          environment(id: $environmentId) {
            serviceInstances(first: 100) {
              edges { node {
                serviceId serviceName numReplicas tracingEnabled
                source { image repo }
                latestDeployment { id status createdAt statusUpdatedAt }
                domains {
                  serviceDomains { domain }
                  customDomains { domain status { certificateStatus } }
                }
              } }
            }
          }
        }`,
        { environmentId },
      )
      return data.environment.serviceInstances.edges
        .map(({ node }) => ({
          id: node.serviceId,
          name: node.serviceName,
          image: node.source?.image ?? null,
          repo: node.source?.repo ?? null,
          replicas: node.numReplicas,
          tracingEnabled: node.tracingEnabled,
          domains: [
            ...node.domains.customDomains.map((entry) => ({
              domain: entry.domain,
              kind: 'custom' as const,
              certificate: entry.status?.certificateStatus?.replace('CERTIFICATE_STATUS_TYPE_', '').toLowerCase() ?? null,
            })),
            ...node.domains.serviceDomains.map((entry) => ({ domain: entry.domain, kind: 'railway' as const, certificate: null })),
          ],
          deployment: node.latestDeployment,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async deployments(limit) {
      const data = await gql<{
        deployments: {
          edges: {
            node: {
              id: string
              status: string
              createdAt: string
              statusUpdatedAt: string | null
              serviceId: string | null
              canRollback: boolean
              service: { name: string } | null
              meta: Record<string, unknown> | null
            }
          }[]
        }
      }>(
        `query Deployments($input: DeploymentListInput!, $first: Int) {
          deployments(input: $input, first: $first) {
            edges { node { id status createdAt statusUpdatedAt serviceId canRollback service { name } meta } }
          }
        }`,
        { input: { projectId, environmentId }, first: limit },
      )
      return data.deployments.edges.map(({ node }) => {
        const meta = node.meta ?? {}
        const commit = typeof meta.commitMessage === 'string' ? meta.commitMessage.split('\n')[0] : null
        const source =
          commit ??
          (typeof meta.cliMessage === 'string' && meta.cliMessage ? meta.cliMessage : null) ??
          (typeof meta.image === 'string' ? meta.image : null) ??
          (typeof meta.reason === 'string' ? meta.reason : null)
        return {
          id: node.id,
          serviceId: node.serviceId,
          service: node.service?.name ?? 'unknown',
          status: node.status,
          createdAt: node.createdAt,
          statusUpdatedAt: node.statusUpdatedAt,
          source,
          canRollback: node.canRollback,
        }
      })
    },

    async logs({ serviceId, filter, limit, before }) {
      const parts = [serviceId ? `@service:${serviceId}` : '', filter?.trim() ?? ''].filter(Boolean)
      const data = await gql<{
        environmentLogs: {
          timestamp: string
          message: string
          severity: string | null
          attributes: { key: string; value: string }[]
          tags: { serviceId: string | null; deploymentId: string | null } | null
        }[]
      }>(
        `query Logs($environmentId: String!, $filter: String, $beforeDate: String, $beforeLimit: Int) {
          environmentLogs(environmentId: $environmentId, filter: $filter, beforeDate: $beforeDate, beforeLimit: $beforeLimit) {
            timestamp message severity
            attributes { key value }
            tags { serviceId deploymentId }
          }
        }`,
        { environmentId, filter: parts.join(' ') || null, beforeDate: before ?? null, beforeLimit: limit },
      )
      return data.environmentLogs.map((line) => {
        const attributes: Record<string, unknown> = {}
        for (const { key, value } of line.attributes) {
          // Railway stores each attribute as JSON text; `level` and `timestamp`
          // repeat the line's own fields.
          if (key === 'level' || key === 'timestamp') continue
          try {
            attributes[key] = JSON.parse(value)
          } catch {
            attributes[key] = value
          }
        }
        return {
          timestamp: line.timestamp,
          message: line.message,
          severity: (line.severity ?? 'info').toLowerCase(),
          serviceId: line.tags?.serviceId ?? null,
          deploymentId: line.tags?.deploymentId ?? null,
          attributes,
        }
      })
    },

    async resourceMetrics(hours) {
      const data = await gql<{
        metrics: { measurement: string; tags: { serviceId: string | null }; values: { ts: number; value: number }[] }[]
      }>(
        `query Metrics($environmentId: String!, $startDate: DateTime!, $sampleRateSeconds: Int) {
          metrics(
            environmentId: $environmentId, startDate: $startDate,
            measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB, NETWORK_RX_GB, DISK_USAGE_GB],
            groupBy: [SERVICE_ID], sampleRateSeconds: $sampleRateSeconds
          ) { measurement tags { serviceId } values { ts value } }
        }`,
        { environmentId, startDate: since(hours), sampleRateSeconds: stepSecondsFor(hours) },
      )
      return data.metrics
        .filter((series) => series.tags.serviceId)
        .map((series) => ({
          serviceId: series.tags.serviceId,
          measurement: series.measurement,
          points: series.values.map((point) => ({ at: point.ts, value: point.value })),
        }))
    },

    async httpTraffic(serviceId, hours) {
      const data = await gql<{
        httpMetricsGroupedByStatus: { statusCode: number; samples: { ts: number; value: number }[] }[]
        httpDurationMetrics: { samples: { ts: number; p50: number; p95: number; p99: number }[] }
      }>(
        `query HttpTraffic($serviceId: String!, $environmentId: String!, $startDate: DateTime!, $endDate: DateTime!, $stepSeconds: Int) {
          httpMetricsGroupedByStatus(serviceId: $serviceId, environmentId: $environmentId, startDate: $startDate, endDate: $endDate, stepSeconds: $stepSeconds) {
            statusCode samples { ts value }
          }
          httpDurationMetrics(serviceId: $serviceId, environmentId: $environmentId, startDate: $startDate, endDate: $endDate, stepSeconds: $stepSeconds) {
            samples { ts p50 p95 p99 }
          }
        }`,
        { serviceId, environmentId, startDate: since(hours), endDate: new Date().toISOString(), stepSeconds: stepSecondsFor(hours) },
      )
      return {
        byStatus: data.httpMetricsGroupedByStatus.map((group) => ({
          status: group.statusCode,
          points: group.samples.map((sample) => ({ at: sample.ts, value: sample.value })),
        })),
        latency: data.httpDurationMetrics.samples.map((sample) => ({ at: sample.ts, p50: sample.p50, p95: sample.p95, p99: sample.p99 })),
      }
    },
  }
}
