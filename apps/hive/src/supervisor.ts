import { execFile, spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { Account, Accounts } from './accounts.js'
import type { ProviderConfig } from './config.js'
import type { AgentReport } from './console.js'
import { parseAgentLine, type Logger } from './log.js'
import type { LlmProxy } from './proxy.js'
import { backoffSeconds, buildAgentEnv, FAILED_AFTER, plan, redact, type AgentSpec, type Provider } from './spec.js'

// Runs one buzz-acp process per hosted agent and keeps that set equal to what
// the console asks for: starting what is missing, restarting what changed,
// stopping what was removed, and bringing back what crashed, more slowly each
// time it crashes again.

export interface SupervisorOptions {
  relayUrl: string
  /** Loopback URL of the model proxy, without a trailing slash. */
  proxyUrl: string
  stopTimeoutMs: number
  providers: Record<Provider, ProviderConfig>
  accounts: Accounts
  proxy: LlmProxy
  log: Logger
  /** The upstream binaries; replaced by stand-ins in tests. */
  commands?: { harness: string; cli: string }
  /** How long a process must stay up to be reported as running, and to have its crashes forgotten. */
  healthyAfterMs?: number
  steadyAfterMs?: number
}

export interface Supervisor {
  /** Moves the running set toward `desired`. Resolves once stops have finished; starts continue in the background. */
  sync(desired: AgentSpec[]): Promise<void>
  report(): AgentReport[]
  shutdown(): Promise<void>
}

interface Managed {
  spec: AgentSpec
  account: Account
  phase: AgentReport['state']
  child: ChildProcess | null
  /** Resolves when the current child has exited. */
  exited: Promise<void> | null
  /** The start in progress: publishing the profile, then spawning. */
  launching: Promise<void> | null
  cancelLaunch: AbortController | null
  /** Exits in a row without a steady stretch in between. */
  failures: number
  restarts: number
  startedAt: number | null
  lastExit: string | null
  lastError: string | null
  /** The most recent warning or error the process logged, kept to explain an exit. */
  lastProblem: string | null
  retryAt: number
  /** The revision whose profile and channel policy are already published. */
  provisioned: string | null
  timers: NodeJS.Timeout[]
}

const CLI_TIMEOUT_MS = 30_000
const truncate = (text: string, length = 300) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { accounts, proxy, log } = options
  const commands = options.commands ?? { harness: 'buzz-acp', cli: 'buzz' }
  const healthyAfterMs = options.healthyAfterMs ?? 20_000
  const steadyAfterMs = options.steadyAfterMs ?? 300_000
  const managed = new Map<string, Managed>()

  const identity = (account: Account) => (account.uid === undefined ? {} : { uid: account.uid, gid: account.gid })

  function runCli(m: Managed, env: Record<string, string>, args: string[], signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(
        commands.cli,
        args,
        { env, cwd: m.account.home, timeout: CLI_TIMEOUT_MS, signal, ...identity(m.account) },
        (error, stdout, stderr) => resolve({ ok: !error, output: `${stderr || stdout || error?.message || ''}`.trim() }),
      )
    })
  }

  /**
   * Publishes what buzz-acp does not publish itself: the agent's profile, who
   * may add it to channels, and for a personal agent the direct conversation
   * its owner will find it in. Returns whether it is done for this revision.
   */
  async function provision(m: Managed, env: Record<string, string>, secrets: string[], signal: AbortSignal): Promise<boolean> {
    const agentLog = log.child({ agent_id: m.spec.id, agent: m.spec.name })
    const steps: { what: string; args: string[]; required: boolean }[] = [
      {
        what: 'publish profile',
        args: ['users', 'set-profile', '--name', m.spec.name, ...(m.spec.about ? ['--about', m.spec.about] : [])],
        required: true,
      },
      { what: 'set channel add policy', args: ['channels', 'set-add-policy', '--policy', m.spec.addPolicy], required: true },
    ]
    // Buzz only lets a member message an agent it already shares a conversation with, so the agent opens one.
    if (m.spec.respondTo === 'owner-only') {
      steps.push({ what: 'open conversation with owner', args: ['dms', 'open', '--pubkey', m.spec.ownerPubkey], required: false })
    }

    let complete = true
    for (const step of steps) {
      if (signal.aborted) return false
      const result = await runCli(m, env, step.args, signal)
      if (result.ok) continue
      if (step.required) complete = false
      agentLog.warn({ step: step.what, output: truncate(redact(result.output, secrets)) }, `could not ${step.what}`)
    }
    return complete
  }

  function spawnAgent(m: Managed, env: Record<string, string>, secrets: string[]) {
    const agentLog = log.child({ agent_id: m.spec.id, agent: m.spec.name })
    // A process cap per agent keeps a runaway shell command from starving the others.
    const child = spawn('/bin/sh', ['-c', 'ulimit -n 4096 2>/dev/null; ulimit -u 512 2>/dev/null; exec "$0"', commands.harness], {
      cwd: m.account.home,
      env,
      // Its own process group, so stopping it also stops whatever its tools started.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...identity(m.account),
    })

    m.child = child
    m.phase = 'starting'
    m.startedAt = Date.now()
    m.lastProblem = null

    for (const [stream, source] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const) {
      if (!source) continue
      readline.createInterface({ input: source }).on('line', (raw) => {
        const { level, message } = parseAgentLine(redact(raw, secrets))
        if (!message) return
        if (level === 'warn' || level === 'error') m.lastProblem = message
        agentLog[level]({ stream }, message)
      })
    }

    m.timers.push(
      setTimeout(() => {
        if (m.child === child) m.phase = 'running'
      }, healthyAfterMs),
      setTimeout(() => {
        if (m.child !== child) return
        m.failures = 0
        m.lastError = null
      }, steadyAfterMs),
    )

    m.exited = new Promise<void>((resolve) => {
      let settled = false
      const settle = (reason: string) => {
        if (settled) return
        settled = true
        for (const timer of m.timers.splice(0)) clearTimeout(timer)
        m.child = null
        proxy.revoke(m.spec.id)
        if (m.phase === 'stopping') {
          agentLog.info({}, 'agent stopped')
        } else {
          m.failures += 1
          m.restarts += 1
          m.lastExit = new Date().toISOString()
          m.lastError = truncate(m.lastProblem ? `${reason}: ${m.lastProblem}` : reason)
          m.phase = m.failures >= FAILED_AFTER ? 'failed' : 'backoff'
          const wait = backoffSeconds(m.failures)
          m.retryAt = Date.now() + wait * 1000
          agentLog.warn({ failures: m.failures, retry_in_seconds: wait }, `agent exited: ${m.lastError}`)
        }
        resolve()
      }
      child.once('exit', (code, signal) => settle(signal ? `stopped by ${signal}` : `exited with code ${code}`))
      // Emitted instead of `exit` when the process could not be started at all.
      child.once('error', (error) => settle(`could not start: ${error.message}`))
    })
    agentLog.info({ pid: child.pid, provider: m.spec.provider, model: m.spec.model, respond_to: m.spec.respondTo }, 'agent started')
  }

  function launch(m: Managed) {
    if (m.child || m.launching) return
    const provider = options.providers[m.spec.provider]
    if (!provider.apiKey) {
      m.phase = 'failed'
      m.lastError = `The agent host has no ${provider.variable}. Set it on the hive service.`
      m.retryAt = Date.now() + 60_000
      return
    }

    const cancel = new AbortController()
    m.cancelLaunch = cancel
    m.phase = 'starting'
    m.startedAt = Date.now()
    m.launching = (async () => {
      const token = proxy.grant(m.spec.id, m.spec.provider)
      const secrets = [m.spec.secretKey, token]
      const env = buildAgentEnv(m.spec, {
        relayUrl: options.relayUrl,
        home: m.account.home,
        user: m.account.user,
        proxyUrl: options.proxyUrl,
        proxyToken: token,
      })
      if (m.provisioned !== m.spec.revision && (await provision(m, env, secrets, cancel.signal))) {
        m.provisioned = m.spec.revision
      }
      if (cancel.signal.aborted) {
        proxy.revoke(m.spec.id)
        return
      }
      spawnAgent(m, env, secrets)
    })()
      .catch((error) => {
        m.phase = 'backoff'
        m.failures += 1
        m.lastError = truncate(`could not start: ${error instanceof Error ? error.message : String(error)}`)
        m.retryAt = Date.now() + backoffSeconds(m.failures) * 1000
        log.error({ agent_id: m.spec.id, agent: m.spec.name, err: error }, 'agent could not be started')
      })
      .finally(() => {
        m.launching = null
        m.cancelLaunch = null
      })
  }

  /** Stops an agent's process and waits until it is gone. */
  async function halt(m: Managed) {
    m.cancelLaunch?.abort()
    await m.launching
    const child = m.child
    if (!child?.pid) return
    m.phase = 'stopping'
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        child.kill(signal)
      }
    }
    // buzz-acp finishes turns in flight and says goodbye on SIGTERM; give it the time it asks for.
    signalGroup('SIGTERM')
    const force = setTimeout(() => signalGroup('SIGKILL'), options.stopTimeoutMs)
    await m.exited
    clearTimeout(force)
  }

  async function remove(id: string) {
    const m = managed.get(id)
    if (!m) return
    await halt(m)
    proxy.revoke(id)
    accounts.remove(id)
    managed.delete(id)
    log.info({ agent_id: id, agent: m.spec.name }, 'agent removed from this host')
  }

  return {
    async sync(desired) {
      const running = new Map([...managed].map(([id, m]) => [id, { revision: m.spec.revision }]))
      const changes = plan(desired, running)

      await Promise.all([
        ...changes.stop.map(remove),
        ...changes.restart.map(async (spec) => {
          const m = managed.get(spec.id)!
          await halt(m)
          m.spec = spec
          m.failures = 0
          m.lastError = null
          launch(m)
        }),
      ])

      for (const spec of changes.start) {
        const m: Managed = {
          spec,
          account: accounts.ensure(spec.id),
          phase: 'starting',
          child: null,
          exited: null,
          launching: null,
          cancelLaunch: null,
          failures: 0,
          restarts: 0,
          startedAt: null,
          lastExit: null,
          lastError: null,
          lastProblem: null,
          retryAt: 0,
          provisioned: null,
          timers: [],
        }
        managed.set(spec.id, m)
        launch(m)
      }

      const now = Date.now()
      for (const m of managed.values()) {
        if ((m.phase === 'backoff' || m.phase === 'failed') && m.retryAt <= now) launch(m)
      }
    },

    report() {
      return [...managed.values()].map((m) => ({
        id: m.spec.id,
        state: m.phase,
        detail: {
          restarts: m.restarts,
          ...(m.lastError ? { lastError: m.lastError } : {}),
          ...(m.child && m.startedAt ? { startedAt: new Date(m.startedAt).toISOString() } : {}),
          ...(m.lastExit ? { lastExit: m.lastExit } : {}),
        },
      }))
    },

    async shutdown() {
      await Promise.all([...managed.values()].map(halt))
    },
  }
}
