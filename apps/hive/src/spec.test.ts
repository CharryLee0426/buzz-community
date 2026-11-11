import { describe, expect, it } from 'vitest'
import { parseAgentLine } from './log.js'
import { backoffSeconds, buildAgentEnv, parseDesired, plan, redact, type AgentSpec } from './spec.js'

const KEY = 'a'.repeat(64)
const OWNER = 'b'.repeat(64)

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Release helper',
    about: '',
    pubkey: 'c'.repeat(64),
    secretKey: KEY,
    authTag: JSON.stringify(['auth', OWNER, '', 'd'.repeat(128)]),
    ownerPubkey: OWNER,
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

const host = { relayUrl: 'wss://buzz.example.com', home: '/home/agents/x', user: 'agent0', proxyUrl: 'http://127.0.0.1:8791', proxyToken: 'hive-token' }

describe('plan', () => {
  it('starts what is missing, restarts what changed and stops what is gone', () => {
    const running = new Map([
      ['same', { revision: 'r1' }],
      ['changed', { revision: 'r1' }],
      ['gone', { revision: 'r1' }],
    ])
    const result = plan([spec({ id: 'same' }), spec({ id: 'changed', revision: 'r2' }), spec({ id: 'new' })], running)
    expect(result.start.map((agent) => agent.id)).toEqual(['new'])
    expect(result.restart.map((agent) => agent.id)).toEqual(['changed'])
    expect(result.stop).toEqual(['gone'])
  })
})

describe('backoffSeconds', () => {
  it('doubles, is capped, and slows right down once an agent counts as failed', () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([2, 4, 8, 16, 32])
    expect(backoffSeconds(6)).toBe(600)
    expect(backoffSeconds(40)).toBe(600)
  })
})

describe('parseDesired', () => {
  it('accepts what the console sends', () => {
    const { agents, rejected } = parseDesired({ agents: [spec()] })
    expect(rejected).toEqual([])
    expect(agents).toHaveLength(1)
  })

  it('skips a malformed agent without dropping the others', () => {
    const { agents, rejected } = parseDesired({ agents: [spec(), spec({ id: '22222222-2222-4222-8222-222222222222', model: 'x; rm -rf /' })] })
    expect(agents).toHaveLength(1)
    expect(rejected).toEqual([{ id: '22222222-2222-4222-8222-222222222222', reason: expect.stringContaining('model') }])
  })

  it('rejects a response that is not a list', () => {
    expect(() => parseDesired({})).toThrow()
  })
})

describe('buildAgentEnv', () => {
  it('gives a personal agent its owner-only settings and the proxy in place of a provider key', () => {
    const env = buildAgentEnv(spec({ instructions: 'Be brief.' }), host)
    expect(env.BUZZ_ACP_RESPOND_TO).toBe('owner-only')
    expect(env.BUZZ_ACP_ALLOWED_RESPOND_TO).toBe('owner-only')
    expect(env.BUZZ_ACP_RELAY_OBSERVER).toBe('true')
    expect(env.BUZZ_ACP_SYSTEM_PROMPT).toBe('Be brief.')
    expect(env.ANTHROPIC_API_KEY).toBe('hive-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8791/anthropic')
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-5-5')
    expect(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST).toBeUndefined()
  })

  it('passes the allowlist only in allowlist mode', () => {
    const env = buildAgentEnv(spec({ respondTo: 'allowlist', allowlist: [OWNER, KEY], addPolicy: 'anyone' }), host)
    expect(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST).toBe(`${OWNER},${KEY}`)
    expect(env.BUZZ_ACP_RELAY_OBSERVER).toBeUndefined()
    expect(env.BUZZ_ACP_AGENTS).toBe('2')
  })

  it('routes each provider through its own proxy path', () => {
    expect(buildAgentEnv(spec({ provider: 'openai', model: 'gpt-x' }), host).OPENAI_COMPAT_BASE_URL).toBe('http://127.0.0.1:8791/openai')
    expect(buildAgentEnv(spec({ provider: 'openrouter', model: 'a/b' }), host).OPENROUTER_BASE_URL).toBe('http://127.0.0.1:8791/openrouter')
  })

  it('carries nothing from the host process', () => {
    process.env.HIVE_TOKEN = 'console-secret'
    const env = buildAgentEnv(spec(), host)
    expect(Object.values(env)).not.toContain('console-secret')
    expect(env.HIVE_TOKEN).toBeUndefined()
    delete process.env.HIVE_TOKEN
  })
})

describe('redact', () => {
  it('removes known secrets and anything shaped like a secret key', () => {
    const line = `key=${KEY} token=hive-token nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsaqcde done`
    const cleaned = redact(line, [KEY, 'hive-token'])
    expect(cleaned).toBe('key=[redacted] token=[redacted] [redacted] done')
  })
})

describe('parseAgentLine', () => {
  it('reads the level from a tracing line and drops the prefix', () => {
    expect(parseAgentLine('2026-11-11T05:00:00.123456Z  WARN buzz_acp::relay: reconnecting')).toEqual({ level: 'warn', message: 'buzz_acp::relay: reconnecting' })
    expect(parseAgentLine('\u001b[2m2026-11-11T05:00:00Z\u001b[0m ERROR boom')).toEqual({ level: 'error', message: 'boom' })
  })

  it('treats anything else as information', () => {
    expect(parseAgentLine('plain output')).toEqual({ level: 'info', message: 'plain output' })
  })
})
