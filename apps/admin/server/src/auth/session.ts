import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Sessions are stateless signed tokens, so the console can still authenticate
// when Postgres is down — which is exactly when an operator needs it.
// Token: v1.<payload b64url>.<hmac b64url>, payload = {sub, iat, exp, csrf}.

export interface Session {
  /** Username. */
  sub: string
  /** Issued-at, epoch seconds. */
  iat: number
  /** Expiry, epoch seconds. */
  exp: number
  /** Per-session token the client echoes in a header on every write. */
  csrf: string
}

export interface SessionCodec {
  issue(username: string, now?: number): { token: string; session: Session }
  /** A fresh token for the same operator and CSRF token, so an open page keeps working. */
  renew(session: Session, now?: number): { token: string; session: Session }
  read(token: string | undefined, now?: number): Session | null
  /** True once a session has used up half its lifetime and should be reissued. */
  shouldRenew(session: Session, now?: number): boolean
  readonly ttlSeconds: number
}

const VERSION = 'v1'

export function createSessionCodec(secret: string, ttlSeconds = 12 * 60 * 60): SessionCodec {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error('SESSION_SECRET must be at least 32 bytes')
  }
  const sign = (payload: string) => createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest()
  const seconds = (now?: number) => Math.floor((now ?? Date.now()) / 1000)

  const encode = (session: Session) => {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
    return { token: `${VERSION}.${payload}.${sign(payload).toString('base64url')}`, session }
  }

  return {
    ttlSeconds,
    issue(username, now) {
      const iat = seconds(now)
      return encode({ sub: username, iat, exp: iat + ttlSeconds, csrf: randomBytes(18).toString('base64url') })
    },
    renew(session, now) {
      const iat = seconds(now)
      return encode({ sub: session.sub, iat, exp: iat + ttlSeconds, csrf: session.csrf })
    },
    read(token, now) {
      if (!token) return null
      const parts = token.split('.')
      if (parts.length !== 3 || parts[0] !== VERSION) return null
      const [, payload, signature] = parts as [string, string, string]
      const expected = sign(payload)
      const given = Buffer.from(signature, 'base64url')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      let session: Session
      try {
        session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
      } catch {
        return null
      }
      if (typeof session.sub !== 'string' || typeof session.exp !== 'number' || typeof session.csrf !== 'string') {
        return null
      }
      return session.exp > seconds(now) ? session : null
    },
    shouldRenew(session, now) {
      return session.exp - seconds(now) < ttlSeconds / 2
    },
  }
}
