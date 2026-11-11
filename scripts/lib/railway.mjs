// Thin wrappers over the Railway CLI for the setup scripts.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class CommandError extends Error {
  constructor(command, result) {
    const detail = (result.stderr || result.stdout || '').toString().trim()
    super(`${command} exited with ${result.status ?? result.signal}${detail ? `:\n${detail}` : ''}`)
    this.name = 'CommandError'
    this.status = result.status
  }
}

/** Runs `railway <args>` and returns stdout. Secrets must travel in `env` or `input`, never in args. */
export function railway(args, { env, input, inherit = false, allowFailure = false, timeoutMs } = {}) {
  // The IaC SDK finds the CLI through the shell's `_` variable. Under a Node
  // parent that names `node`, which fails the SDK's version check, so drop it
  // and let the SDK fall back to `railway` on PATH.
  const { _: _shellCommand, ...inherited } = process.env
  const result = spawnSync('railway', args, {
    encoding: 'utf8',
    env: { ...inherited, ...env },
    input,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
  if (result.error?.code === 'ETIMEDOUT' && allowFailure) return { ok: false, timedOut: true, stdout: '', stderr: '' }
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('The Railway CLI is not installed. Install it with `brew install railway` or `npm i -g @railway/cli`.')
    }
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) throw new CommandError(`railway ${args.join(' ')}`, result)
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function railwayJson(args, options) {
  const { ok, stdout, stderr } = railway([...args, '--json'], options)
  if (!ok) return { ok, data: undefined, stderr }
  try {
    return { ok, data: JSON.parse(stdout), stderr }
  } catch {
    throw new Error(`railway ${args.join(' ')} --json did not print JSON:\n${stdout.slice(0, 400)}`)
  }
}

/** Runs a GraphQL document through the logged-in CLI session. */
export function graphql(query, variables = {}) {
  const { stdout } = railway(['api', query, '--variables', JSON.stringify(variables), '--compact'])
  const response = JSON.parse(stdout)
  if (response.errors?.length) {
    throw new Error(`Railway API: ${response.errors.map((error) => error.message).join('; ')}`)
  }
  return response.data
}

export function cliVersion() {
  const { stdout } = railway(['--version'])
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error(`Could not read the Railway CLI version from "${stdout.trim()}".`)
  return match.slice(1).map(Number)
}

export function versionAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if ((version[i] ?? 0) > minimum[i]) return true
    if ((version[i] ?? 0) < minimum[i]) return false
  }
  return true
}

/**
 * The environment this directory is linked to. `railway status` does not
 * report it, so it is read from the CLI's own link file.
 */
function linkedEnvironment(projectId, environments) {
  const file = join(homedir(), '.railway', 'config.json')
  if (existsSync(file)) {
    try {
      const links = Object.values(JSON.parse(readFileSync(file, 'utf8')).projects ?? {})
      const link = links
        .filter((entry) => entry.project === projectId && process.cwd().startsWith(entry.projectPath))
        .sort((a, b) => b.projectPath.length - a.projectPath.length)[0]
      const match = environments.find((environment) => environment.id === link?.environment)
      if (match) return match
    } catch {
      // fall through to the default below
    }
  }
  return environments.find((environment) => environment.name === 'production') ?? environments[0]
}

/** The linked project and environment, or null when this directory is not linked. */
export function linkedProject() {
  const { ok, data } = railwayJson(['status'], { allowFailure: true })
  if (!ok || !data?.id) return null
  const environments = (data.environments?.edges ?? []).map((edge) => edge.node)
  const services = (data.services?.edges ?? []).map((edge) => edge.node)
  return {
    id: data.id,
    name: data.name,
    workspaceId: data.workspaceId ?? data.workspace?.id,
    environment: linkedEnvironment(data.id, environments),
    environments,
    services,
  }
}

/** Names of the variables a service already has. Sealed values come back as null but the key is listed. */
export function variableNames(service) {
  const { ok, data } = railwayJson(['variable', 'list', '--service', service], { allowFailure: true })
  if (!ok || !data) return new Set()
  return new Set(Object.keys(data))
}

/**
 * The domains attached to a service: `type` is "custom" for your own hostname
 * and "service" for the one Railway generates.
 */
export function domains(service) {
  const { ok, data } = railwayJson(['domain', 'list', '--service', service], { allowFailure: true })
  return ok && Array.isArray(data?.domains) ? data.domains : []
}

/** DNS records, verification token and certificate state of one custom domain, or null if it is not attached. */
export function domainStatus(service, domain) {
  const { ok, data } = railwayJson(['domain', 'status', domain, '--service', service], { allowFailure: true })
  return ok ? (data?.domain ?? null) : null
}

/** The latest deployment status of every service in the linked environment. */
export function serviceStatuses() {
  const { ok, data } = railwayJson(['service', 'list'], { allowFailure: true })
  if (!ok || !Array.isArray(data)) return []
  return data.map((service) => ({ name: service.name, status: service.status ?? service.latestDeployment?.status ?? null }))
}
