import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from './log.js'
import { createLlmProxy, type LlmProxy } from './proxy.js'

const quiet = createLogger('error', {}, () => undefined)

interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

let upstream: http.Server | undefined
let proxy: LlmProxy | undefined

async function start({ anthropicKey = 'sk-real' as string | null } = {}) {
  const apiKey = anthropicKey ?? undefined
  const seen: Seen[] = []
  upstream = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push({ url: request.url ?? '', headers: request.headers, body })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'set-cookie': 'a=b' })
      response.write('event: one\n\n')
      response.end('event: two\n\n')
    })
  })
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  proxy = createLlmProxy(
    {
      anthropic: { apiKey, baseUrl: base, variable: 'ANTHROPIC_API_KEY' },
      openai: { apiKey: 'sk-openai', baseUrl: `${base}/v1`, variable: 'OPENAI_API_KEY' },
      openrouter: { apiKey: undefined, baseUrl: `${base}/api/v1`, variable: 'OPENROUTER_API_KEY' },
    },
    quiet,
  )
  await proxy.listen(0)
  return { seen, url: `http://127.0.0.1:${proxy.port()}` }
}

afterEach(async () => {
  await proxy?.close()
  await new Promise((resolve) => upstream?.close(resolve) ?? resolve(undefined))
  proxy = undefined
  upstream = undefined
})

describe('model proxy', () => {
  it('swaps the agent token for the real key and streams the answer back', async () => {
    const { seen, url } = await start()
    const token = proxy!.grant('agent-1', 'anthropic')
    const response = await fetch(`${url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', cookie: 'x=y' },
      body: '{"model":"m"}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('event: one\n\nevent: two\n\n')
    expect(response.headers.get('request-id')).toBe('req_1')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('/v1/messages')
    expect(seen[0]!.headers['x-api-key']).toBe('sk-real')
    expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0]!.headers.cookie).toBeUndefined()
    expect(seen[0]!.body).toBe('{"model":"m"}')
  })

  it('uses a bearer credential for OpenAI-compatible providers', async () => {
    const { seen, url } = await start()
    const token = proxy!.grant('agent-2', 'openai')
    const response = await fetch(`${url}/openai/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(200)
    expect(seen[0]!.url).toBe('/v1/chat/completions')
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-openai')
  })

  it('refuses an unknown token, another provider, and anything but inference', async () => {
    const { seen, url } = await start()
    const token = proxy!.grant('agent-1', 'anthropic')
    const post = (path: string, key: string) => fetch(`${url}${path}`, { method: 'POST', headers: { 'x-api-key': key }, body: '{}' })

    expect((await post('/anthropic/v1/messages', 'hive-guess')).status).toBe(401)
    expect((await post('/openai/chat/completions', token)).status).toBe(403)
    expect((await post('/anthropic/v1/files', token)).status).toBe(404)
    expect((await post('/anthropic/v1/messages/batches', token)).status).toBe(404)
    expect((await fetch(`${url}/anthropic/v1/messages`, { headers: { 'x-api-key': token } })).status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('stops honouring a token once it is revoked or replaced', async () => {
    const { url } = await start()
    const first = proxy!.grant('agent-1', 'anthropic')
    const second = proxy!.grant('agent-1', 'anthropic')
    const post = (key: string) => fetch(`${url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': key }, body: '{}' })
    expect((await post(first)).status).toBe(401)
    expect((await post(second)).status).toBe(200)
    proxy!.revoke('agent-1')
    expect((await post(second)).status).toBe(401)
  })

  it('says which variable is missing when the host has no key', async () => {
    const { url } = await start({ anthropicKey: null })
    const token = proxy!.grant('agent-1', 'anthropic')
    const response = await fetch(`${url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('ANTHROPIC_API_KEY')
  })
})
