import { z } from 'zod'
import { verifyPassword } from '../../auth/password.js'
import type { Session } from '../../auth/session.js'
import { ApiProblem, type AppContext } from '../../context.js'
import { API, clearSessionCookie, readSession, safeEqual, setSessionCookie, type App } from '../app.js'

const credentials = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
})

const describe = (session: Session) => ({
  username: session.sub,
  csrf: session.csrf,
  expiresAt: new Date(session.exp * 1000).toISOString(),
})

export function sessionRoutes(app: App, ctx: AppContext) {
  app.get(`${API}/session`, (c) => {
    const session = readSession(c, ctx)
    if (!session) throw new ApiProblem(401, 'signed_out', 'Not signed in.')
    return c.json(describe(session))
  })

  app.post(`${API}/session`, async (c) => {
    const clientIp = c.get('clientIp')
    const origin = c.req.header('origin')
    if (origin && origin !== ctx.config.PUBLIC_ORIGIN) {
      throw new ApiProblem(403, 'cross_origin', 'This request came from another site and was refused.')
    }

    const wait = ctx.throttle.retryAfter(clientIp)
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      throw new ApiProblem(429, 'throttled', 'Too many failed sign-in attempts. Wait before trying again.')
    }

    const { username, password } = credentials.parse(await c.req.json().catch(() => ({})))
    // Always run the password check, so a wrong username takes as long as a wrong password.
    const passwordOk = await verifyPassword(password, ctx.config.ADMIN_PASSWORD_HASH)
    const usernameOk = safeEqual(username, ctx.config.ADMIN_USERNAME)

    if (!usernameOk || !passwordOk) {
      ctx.throttle.recordFailure(clientIp)
      ctx.log.warn({ component: 'auth', client_ip: clientIp }, 'sign-in failed')
      await ctx.store?.recordAudit({ actor: 'anonymous', action: 'session.failed', clientIp }).catch(() => undefined)
      throw new ApiProblem(401, 'bad_credentials', 'The username or password is wrong.')
    }

    ctx.throttle.recordSuccess(clientIp)
    const { token, session } = ctx.sessions.issue(ctx.config.ADMIN_USERNAME)
    setSessionCookie(c, ctx, token)
    ctx.log.info({ component: 'auth', client_ip: clientIp }, 'operator signed in')
    await ctx.store?.recordAudit({ actor: session.sub, action: 'session.started', clientIp }).catch(() => undefined)
    return c.json(describe(session))
  })

  app.delete(`${API}/session`, async (c) => {
    const session = readSession(c, ctx)
    clearSessionCookie(c, ctx)
    if (session) {
      await ctx.store?.recordAudit({ actor: session.sub, action: 'session.ended', clientIp: c.get('clientIp') }).catch(() => undefined)
    }
    return c.body(null, 204)
  })
}
