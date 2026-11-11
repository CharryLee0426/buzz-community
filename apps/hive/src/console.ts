import { parseDesired, type AgentSpec } from './spec.js'

export interface AgentReport {
  id: string
  state: 'starting' | 'running' | 'backoff' | 'failed' | 'stopping'
  detail: Record<string, unknown>
}

export interface HostReport {
  version: string
  providers: Record<string, boolean>
  agents: AgentReport[]
}

export interface ConsoleClient {
  desired(): Promise<{ agents: AgentSpec[]; rejected: { id: string; reason: string }[] }>
  report(report: HostReport): Promise<void>
}

/** The host's two calls to the admin console, over the private network. */
export function createConsoleClient(adminUrl: string, token: string): ConsoleClient {
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${adminUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`console answered ${response.status} to ${path}`)
    return response
  }

  return {
    async desired() {
      const response = await call('/internal/hive/desired')
      return parseDesired(await response.json())
    },
    async report(report) {
      await call('/internal/hive/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
    },
  }
}
