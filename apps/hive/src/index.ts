import http from 'node:http'
import { createAccounts } from './accounts.js'
import { loadConfig } from './config.js'
import { createConsoleClient } from './console.js'
import { createLogger } from './log.js'
import { createLlmProxy } from './proxy.js'
import type { AgentSpec } from './spec.js'
import { createSupervisor } from './supervisor.js'

// The agent host: one container that runs every agent the console hosts for
// the community. It asks the console what should be running, keeps exactly
// that running, and tells the console how each agent is doing.

const VERSION = '0.1.0'

const bootLog = createLogger('info', { service: 'hive' })

let config
try {
  config = loadConfig(process.env)
} catch (error) {
  bootLog.error({ err: error }, `invalid configuration: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const log = createLogger(config.logLevel, { service: 'hive' })
const accounts = createAccounts(config.homeRoot)
const proxy = createLlmProxy(config.providers, log.child({ component: 'proxy' }))
const consoleClient = createConsoleClient(config.adminUrl, config.hiveToken)
const supervisor = createSupervisor({
  relayUrl: config.relayUrl,
  proxyUrl: `http://127.0.0.1:${config.proxyPort}`,
  stopTimeoutMs: config.stopTimeoutSeconds * 1000,
  providers: config.providers,
  accounts,
  proxy,
  log: log.child({ component: 'supervisor' }),
})

const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, Boolean(provider.apiKey)]))
/** `null` until the first attempt, so the first outcome is always logged. */
let consoleReachable: boolean | null = null
/** The last set the console asked for; what keeps running while the console is away. */
let desired: AgentSpec[] = []
let stopping = false

async function tick() {
  try {
    const answer = await consoleClient.desired()
    for (const rejected of answer.rejected) {
      log.error({ agent_id: rejected.id, reason: rejected.reason }, 'the console described an agent this host will not run')
    }
    desired = answer.agents
    if (consoleReachable !== true) log.info({ agents: desired.length }, 'console reachable')
    consoleReachable = true
  } catch (error) {
    // A console restart must not take every agent down with it.
    if (consoleReachable !== false) log.warn({ err: error }, 'console unreachable; keeping the current agents as they are')
    consoleReachable = false
  }

  // Also runs when the console is away, so agents that crashed are still brought back.
  await supervisor.sync(desired)

  if (!consoleReachable) return
  try {
    await consoleClient.report({ version: VERSION, providers, agents: supervisor.report() })
  } catch (error) {
    log.warn({ err: error }, 'could not report agent status to the console')
  }
}

let timer: NodeJS.Timeout | undefined
async function loop() {
  if (stopping) return
  try {
    await tick()
  } catch (error) {
    // One bad pass must not end supervision: the next one runs regardless.
    log.error({ err: error }, 'supervision pass failed')
  }
  if (!stopping) timer = setTimeout(() => void loop(), config!.pollSeconds * 1000)
}

const health = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    const agents = supervisor.report()
    const body = JSON.stringify({
      status: 'ok',
      version: VERSION,
      consoleReachable: consoleReachable === true,
      agents: agents.length,
      running: agents.filter((agent) => agent.state === 'running').length,
    })
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    return
  }
  response.writeHead(404).end()
})

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  log.info({ signal }, 'stopping agents')
  health.close()
  await supervisor.shutdown()
  await proxy.close()
  log.info({}, 'stopped')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled rejection'))

await proxy.listen(config.proxyPort)
health.listen(config.port, config.host)

if (!accounts.isolated) {
  log.warn({}, 'not running as root: agents share one user and are not isolated from each other. Acceptable on a workstation only.')
}
for (const [name, provider] of Object.entries(config.providers)) {
  if (!provider.apiKey) log.info({ provider: name, variable: provider.variable }, `no key for ${name}; agents set up for it will not start`)
}
log.info({ port: config.port, relay: config.relayUrl, console: config.adminUrl, poll_seconds: config.pollSeconds }, 'agent host started')

void loop()
