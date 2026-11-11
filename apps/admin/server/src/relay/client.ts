import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomHex, sha256Hex, unixNow, type Signer } from '../nostr/keys.js'

// Talks to the relay over the private network while naming the community by
// its public host. The relay binds every request to a community from the Host
// header and checks NIP-98 signatures against the public https URL, so both
// are set explicitly instead of following the address that is dialled.

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

export interface RelayResponse<T = unknown> {
  status: number
  data: T
}

export interface RelayRequest {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'
  /** Path and query, e.g. `/moderation/reports?status=open`. */
  path: string
  body?: unknown
  /** Signs the request with NIP-98 when given. */
  signer?: Signer
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface RelayClient {
  readonly communityHost: string
  request<T = unknown>(options: RelayRequest): Promise<RelayResponse<T>>
}

/** NIP-98 Authorization header for one request. The nonce keeps same-second requests distinct. */
export function nip98Header(signer: Signer, url: string, method: string, body?: Buffer): string {
  const tags = [
    ['u', url],
    ['method', method],
    ['nonce', randomHex(16)],
  ]
  if (body) tags.push(['payload', sha256Hex(body)])
  const event = signer.sign({ kind: 27235, created_at: unixNow(), content: '', tags })
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

export function createRelayClient(baseUrl: string, communityHost: string): RelayClient {
  const base = new URL(baseUrl)
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest

  return {
    communityHost,
    request<T>({ method = 'GET', path, body, signer, headers = {}, timeoutMs = 10_000 }: RelayRequest) {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const requestHeaders: Record<string, string | number> = {
        Host: communityHost,
        Accept: 'application/json',
        ...headers,
      }
      if (payload) {
        requestHeaders['Content-Type'] = 'application/json'
        requestHeaders['Content-Length'] = payload.length
      }
      if (signer) {
        requestHeaders.Authorization = nip98Header(signer, `https://${communityHost}${path}`, method, payload)
      }

      return new Promise<RelayResponse<T>>((resolve, reject) => {
        const req = send(
          {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            // Present the dialled name for TLS; Host carries the community.
            servername: base.protocol === 'https:' ? base.hostname : undefined,
            method,
            path,
            headers: requestHeaders,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              let data: unknown = text
              if (text && (res.headers['content-type'] ?? '').includes('json')) {
                try {
                  data = JSON.parse(text)
                } catch {
                  data = text
                }
              }
              const status = res.statusCode ?? 0
              if (status >= 400) {
                reject(new RelayError(describeFailure(status, data), status, data))
              } else {
                resolve({ status, data: data as T })
              }
            })
          },
        )
        req.on('timeout', () => req.destroy(new RelayError(`The relay did not answer ${method} ${path} within ${timeoutMs} ms.`, 504)))
        req.on('error', (error) => {
          reject(error instanceof RelayError ? error : new RelayError(`The relay could not be reached: ${error.message}`, 502))
        })
        if (payload) req.write(payload)
        req.end()
      })
    },
  }
}

function describeFailure(status: number, data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>).message : record.error
    const message = record.message ?? nested
    if (typeof message === 'string' && message) return cleanRefusal(message)
  }
  if (typeof data === 'string' && data.trim()) return cleanRefusal(data.trim().slice(0, 300))
  return `The relay answered with status ${status}.`
}

/** Relay refusals read like "invalid: cannot change your own role"; keep the part a person needs. */
export function cleanRefusal(message: string | undefined): string {
  if (!message) return 'The relay refused the request.'
  const text = message.replace(/^(invalid|blocked|restricted|error|rate-limited|auth-required):\s*/i, '').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'The relay refused the request.'
}
