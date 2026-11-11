import { randomUUID, timingSafeEqual } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { ZodError } from 'zod'
import type { Session } from '../auth/session.js'
import { ApiProblem, type AppContext } from '../context.js'
import { RailwayError } from '../railway/client.js'
import { RelayError } from '../relay/client.js'

export type Env = {
  Variables: {
    session: Session
    clientIp: string
    requestId: string
  }
}

export type App = Hono<Env>

export const BASE = '/admin'
export const API = `${BASE}/api`

const cookieName = (ctx: AppContext) => (ctx.config.isSecureOrigin ? '__Secure-buzz_console' : 'buzz_console')

export function setSessionCookie(c: Context<Env>, ctx: AppContext, token: string) {
  setCookie(c, cookieName(ctx), token, {
    path: BASE,
    httpOnly: true,
    secure: ctx.config.isSecureOrigin,
    sameSite: 'Strict',
    maxAge: ctx.sessions.ttlSeconds,
  })
}

export function clearSessionCookie(c: Context<Env>, ctx: AppContext) {
  deleteCookie(c, cookieName(ctx), { path: BASE, secure: ctx.config.isSecureOrigin })
}

export const readSession = (c: Context<Env>, ctx: AppContext) => ctx.sessions.read(getCookie(c, cookieName(ctx)))

/** Compares secrets without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Astryx injects theme rules as <style> elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/** Identifies the caller and the request, and writes one structured access-log line per request. */
function requestContext(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const started = performance.now()
    // The gateway overwrites this header with the address Railway's edge saw.
    c.set('clientIp', c.req.header('x-buzz-client-ip') ?? 'unknown')
    const requestId = c.req.header('x-railway-request-id') ?? randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)

    await next()

    const route = c.req.routePath
    // Name the span after the route so traces group by endpoint, not by URL.
    const span = trace.getActiveSpan()
    span?.setAttribute('http.route', route)
    span?.updateName(`${c.req.method} ${route}`)

    if (route.endsWith('/healthz')) return
    const status = c.res.status
    const line = {
      component: 'http',
      method: c.req.method,
      route,
      status,
      duration_ms: Math.round(performance.now() - started),
      client_ip: c.get('clientIp'),
      request_id: requestId,
    }
    if (status >= 500) ctx.log.error(line, 'request failed')
    // A 401 is the ordinary answer to a visitor who has not signed in; failed sign-ins are audited on their own.
    else if (status === 401) ctx.log.info(line, 'request refused')
    else if (status >= 400) ctx.log.warn(line, 'request refused')
    // The agent host polls every 15 seconds; its successes would be most of the log.
    else if (route.startsWith('/internal/hive/')) ctx.log.debug(line, 'request')
    else ctx.log.info(line, 'request')
  }
}

const securityHeaders: MiddlewareHandler<Env> = async (c, next) => {
  await next()
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  c.header('Strict-Transport-Security', 'max-age=31536000')
}

/**
 * Admits a signed-in operator. Writes also need the session's CSRF token and,
 * when the browser sends one, an Origin that is the console's own.
 */
export function requireSession(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const session = readSession(c, ctx)
    if (!session) throw new ApiProblem(401, 'signed_out', 'Sign in to continue.')

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (origin && origin !== ctx.config.PUBLIC_ORIGIN) {
        throw new ApiProblem(403, 'cross_origin', 'This request came from another site and was refused.')
      }
      const token = c.req.header('x-csrf-token') ?? ''
      if (!safeEqual(token, session.csrf)) {
        throw new ApiProblem(403, 'csrf', 'The session token on this request is missing or stale. Reload the page and retry.')
      }
    }

    c.set('session', session)
    // Keep an active operator signed in: reissue once half the lifetime is gone.
    if (ctx.sessions.shouldRenew(session)) setSessionCookie(c, ctx, ctx.sessions.renew(session).token)
    await next()
  }
}

export function createApp(ctx: AppContext): App {
  const app = new Hono<Env>()

  app.use('*', requestContext(ctx))
  app.use(`${BASE}/*`, securityHeaders)

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404))

  app.onError((error, c) => {
    if (error instanceof ApiProblem) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    if (error instanceof ZodError) {
      const first = error.issues[0]
      const where = first?.path.length ? `${first.path.join('.')}: ` : ''
      return c.json({ error: { code: 'invalid_request', message: `${where}${first?.message ?? 'The request is not valid.'}` } }, 400)
    }
    if (error instanceof RelayError) {
      // A 4xx from the relay is a refusal with a reason worth showing; anything
      // else means the relay itself is in trouble.
      const refused = error.status >= 400 && error.status < 500
      if (!refused) ctx.log.error({ err: error, component: 'relay' }, 'relay request failed')
      return c.json({ error: { code: refused ? 'relay_refused' : 'relay_unavailable', message: error.message } }, refused ? 422 : 502)
    }
    if (error instanceof RailwayError) {
      ctx.log.warn({ err: error, component: 'railway' }, 'railway request failed')
      return c.json({ error: { code: 'railway_error', message: error.message } }, error.status === 429 ? 429 : 502)
    }
    ctx.log.error({ err: error, component: 'http', request_id: c.get('requestId') }, 'unhandled error')
    return c.json(
      { error: { code: 'internal', message: `The console hit an unexpected error. Reference: ${c.get('requestId')}` } },
      500,
    )
  })

  return app
}
