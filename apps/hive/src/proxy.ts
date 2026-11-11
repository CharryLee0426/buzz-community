import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'
import type { ProviderConfig } from './config.js'
import type { Logger } from './log.js'
import type { Provider } from './spec.js'

// Agents run shell commands that a chat message can ask for, so nothing an
// agent process can read may be worth stealing. Instead of a provider key,
// each agent gets a token that only this loopback proxy accepts, valid for
// that agent's provider and for the inference endpoints alone. The proxy
// swaps in the operator's key on the way out.

const MAX_REQUEST_BYTES = 32 * 1024 * 1024

interface Route {
  /** Paths, relative to the provider's base URL, an agent may POST to. */
  allowed: RegExp
  /** Request headers passed through to the provider. */
  forward: string[]
  credential(key: string): Record<string, string>
}

const ROUTES: Record<Provider, Route> = {
  anthropic: {
    allowed: /^\/v1\/messages(\/count_tokens)?$/,
    forward: ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'],
    credential: (key) => ({ 'x-api-key': key }),
  },
  openai: {
    allowed: /^\/(chat\/completions|responses)$/,
    forward: ['content-type', 'accept'],
    credential: (key) => ({ authorization: `Bearer ${key}` }),
  },
  openrouter: {
    allowed: /^\/chat\/completions$/,
    forward: ['content-type', 'accept'],
    credential: (key) => ({ authorization: `Bearer ${key}`, 'x-title': 'Buzz community agent' }),
  },
}

// What the agent runtime needs back; everything else a provider sends stays here.
const RESPONSE_HEADERS = /^(content-type|retry-after|request-id|x-request-id|anthropic-ratelimit-.*|x-ratelimit-.*)$/

interface Grant {
  agentId: string
  provider: Provider
}

export interface LlmProxy {
  /** Issues the token one agent process presents in place of a provider key. */
  grant(agentId: string, provider: Provider): string
  revoke(agentId: string): void
  listen(port: number): Promise<void>
  close(): Promise<void>
  /** The bound port, for tests that listen on 0. */
  port(): number
}

function presentedToken(request: http.IncomingMessage): string | undefined {
  const apiKey = request.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey) return apiKey
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  return bearer?.[1]
}

function refuse(response: http.ServerResponse, status: number, message: string) {
  // Shaped like a provider error so the agent runtime reports the message instead of a parse failure.
  const body = JSON.stringify({ type: 'error', error: { type: 'agent_host_error', message } })
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body)
}

async function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_REQUEST_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export function createLlmProxy(providers: Record<Provider, ProviderConfig>, log: Logger): LlmProxy {
  const grants = new Map<string, Grant>()
  const tokenOf = new Map<string, string>()

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      log.error({ err: error }, 'model proxy request failed')
      if (!response.headersSent) refuse(response, 502, 'The agent host could not reach the model provider.')
      else response.destroy()
    })
  })

  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const started = Date.now()
    const url = new URL(request.url ?? '/', 'http://proxy')
    const match = /^\/(anthropic|openai|openrouter)(\/.*)$/.exec(url.pathname)
    if (!match) return refuse(response, 404, 'Unknown model provider.')
    const provider = match[1] as Provider
    const path = match[2]!
    const route = ROUTES[provider]

    const grant = grants.get(presentedToken(request) ?? '')
    if (!grant) return refuse(response, 401, 'This agent is not authorized to use the model proxy.')
    if (grant.provider !== provider) return refuse(response, 403, `This agent is set up for ${grant.provider}, not ${provider}.`)
    if (request.method !== 'POST' || !route.allowed.test(path)) return refuse(response, 404, 'Agents may only call the inference endpoints.')

    const upstream = providers[provider]
    if (!upstream.apiKey) return refuse(response, 503, `The agent host has no ${upstream.variable}.`)

    const body = await readBody(request)
    if (!body) return refuse(response, 413, 'The request is larger than the agent host forwards.')

    const headers: Record<string, string> = { ...route.credential(upstream.apiKey) }
    for (const name of route.forward) {
      const value = request.headers[name]
      if (typeof value === 'string') headers[name] = value
    }

    // Stop paying for a generation nobody is waiting for.
    const abort = new AbortController()
    response.on('close', () => {
      if (!response.writableEnded) abort.abort()
    })

    let result: Response
    try {
      result = await fetch(`${upstream.baseUrl}${path}${url.search}`, { method: 'POST', headers, body, signal: abort.signal })
    } catch (error) {
      if (abort.signal.aborted) return
      log.warn({ agent_id: grant.agentId, provider, err: error }, 'model provider unreachable')
      return refuse(response, 502, 'The agent host could not reach the model provider.')
    }

    const outgoing: Record<string, string> = {}
    result.headers.forEach((value, name) => {
      if (RESPONSE_HEADERS.test(name)) outgoing[name] = value
    })
    response.writeHead(result.status, outgoing)
    if (result.body) {
      // Streamed responses reach the agent as they arrive.
      Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0])
        .on('error', () => response.destroy())
        .pipe(response)
    } else {
      response.end()
    }

    const level = result.status >= 500 ? 'warn' : 'info'
    log[level](
      { agent_id: grant.agentId, provider, path, status: result.status, duration_ms: Date.now() - started },
      `model request ${result.status}`,
    )
  }

  return {
    grant(agentId, provider) {
      this.revoke(agentId)
      const token = `hive-${randomBytes(24).toString('base64url')}`
      grants.set(token, { agentId, provider })
      tokenOf.set(agentId, token)
      return token
    },
    revoke(agentId) {
      const token = tokenOf.get(agentId)
      if (!token) return
      grants.delete(token)
      tokenOf.delete(agentId)
    },
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        // Loopback only: the proxy is for processes in this container.
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
    port: () => {
      const address = server.address()
      return address && typeof address === 'object' ? address.port : 0
    },
  }
}
