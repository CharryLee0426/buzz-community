import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccounts } from './accounts.js'
import { createLogger } from './log.js'
import { createLlmProxy } from './proxy.js'
import type { AgentSpec } from './spec.js'
import { createSupervisor, type Supervisor } from './supervisor.js'

const quiet = createLogger('error', {}, () => undefined)
const providers = {
  anthropic: { apiKey: 'sk-real', baseUrl: 'http://127.0.0.1:9', variable: 'ANTHROPIC_API_KEY' },
  openai: { apiKey: undefined, baseUrl: 'http://127.0.0.1:9', variable: 'OPENAI_API_KEY' },
  openrouter: { apiKey: undefined, baseUrl: 'http://127.0.0.1:9', variable: 'OPENROUTER_API_KEY' },
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Helper',
    about: 'Answers questions',
    pubkey: 'c'.repeat(64),
    secretKey: 'a'.repeat(64),
    authTag: '["auth"]',
    ownerPubkey: 'b'.repeat(64),
    respondTo: 'owner-only',
    allowlist: [],
    addPolicy: 'owner_only',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    instructions: '',
    revision: 'r1',
    ...overrides,
  }
}

let dir: string
let supervisor: Supervisor | undefined

function script(name: string, body: string) {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function build(harnessBody: string, cliBody = 'echo "$@" >> "$HOME/cli.log"') {
  supervisor = createSupervisor({
    relayUrl: 'wss://buzz.example.com',
    proxyUrl: 'http://127.0.0.1:8791',
    stopTimeoutMs: 2000,
    providers,
    accounts: createAccounts(path.join(dir, 'homes')),
    proxy: createLlmProxy(providers, quiet),
    log: quiet,
    commands: { harness: script('harness', harnessBody), cli: script('cli', cliBody) },
    healthyAfterMs: 150,
    steadyAfterMs: 60_000,
  })
  return supervisor
}

const state = (id = spec().id) => supervisor!.report().find((agent) => agent.id === id)
async function until(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`timed out waiting until ${what}`)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hive-test-'))
})

afterEach(async () => {
  await supervisor?.shutdown()
  supervisor = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('supervisor', () => {
  it('publishes the profile, starts the agent, and reports it running once it has stayed up', async () => {
    build('echo "$BUZZ_ACP_RESPOND_TO $ANTHROPIC_BASE_URL" > "$HOME/started"; exec sleep 30')
    await supervisor!.sync([spec()])
    await until(() => state()?.state === 'running', 'the agent is running')

    const home = path.join(dir, 'homes', spec().id)
    expect(readFileSync(path.join(home, 'started'), 'utf8').trim()).toBe('owner-only http://127.0.0.1:8791/anthropic')
    expect(readFileSync(path.join(home, 'cli.log'), 'utf8').trim().split('\n')).toEqual([
      'users set-profile --name Helper --about Answers questions',
      'channels set-add-policy --policy owner_only',
      `dms open --pubkey ${'b'.repeat(64)}`,
    ])
    expect(state()?.detail.restarts).toBe(0)
  })

  it('restarts an agent whose revision changed and stops one that was removed', async () => {
    build('echo "$BUZZ_ACP_DISPLAY_NAME" >> "$HOME/names"; exec sleep 30')
    await supervisor!.sync([spec()])
    await until(() => state()?.state === 'running', 'the agent is running')

    await supervisor!.sync([spec({ name: 'Renamed', revision: 'r2' })])
    await until(() => state()?.state === 'running', 'the renamed agent is running')
    expect(readFileSync(path.join(dir, 'homes', spec().id, 'names'), 'utf8').trim().split('\n')).toEqual(['Helper', 'Renamed'])

    await supervisor!.sync([])
    expect(supervisor!.report()).toEqual([])
  })

  it('backs off after a crash and keeps the reason, without the agent key in it', async () => {
    build(`echo "2026-11-11T05:00:00Z ERROR could not authenticate with key ${'a'.repeat(64)}" >&2; exit 3`)
    await supervisor!.sync([spec()])
    await until(() => state()?.state === 'backoff', 'the agent is backing off')

    const detail = state()!.detail as { restarts: number; lastError: string; lastExit: string }
    expect(detail.restarts).toBe(1)
    expect(detail.lastError).toBe('exited with code 3: could not authenticate with key [redacted]')
    expect(detail.lastExit).toMatch(/^\d{4}-/)
  })

  it('does not start an agent whose provider has no key, and says why', async () => {
    build('exec sleep 30')
    await supervisor!.sync([spec({ provider: 'openai', model: 'gpt-x' })])
    expect(state()?.state).toBe('failed')
    expect((state()!.detail as { lastError: string }).lastError).toContain('OPENAI_API_KEY')
  })

  it('still starts the agent when the profile cannot be published', async () => {
    build('exec sleep 30', 'echo "relay unreachable" >&2; exit 1')
    await supervisor!.sync([spec()])
    await until(() => state()?.state === 'running', 'the agent is running')
  })
})
