import { z } from 'zod'
import { ApiProblem, requireRailway, requireStore, type AppContext } from '../../context.js'
import type { AlertSeverity } from '../../db/console.js'
import { API, BASE, requireSession, safeEqual, type App } from '../app.js'

const WINDOWS = [1, 6, 24, 168] as const
const hoursParam = z.coerce
  .number()
  .refine((value): value is (typeof WINDOWS)[number] => (WINDOWS as readonly number[]).includes(value), 'hours must be 1, 6, 24 or 168')
  .default(6)

const logsQuery = z.object({
  service: z.string().trim().max(80).optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  q: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(10).max(1000).default(200),
  before: z.iso.datetime({ offset: true }).optional(),
})

/** Railway's webhook body, as far as the console reads it. */
const webhook = z
  .object({
    type: z.string().max(120),
    severity: z.string().max(20).optional(),
    timestamp: z.string().optional(),
    resource: z
      .object({
        service: z.object({ name: z.string().optional() }).partial().optional(),
        environment: z.object({ name: z.string().optional() }).partial().optional(),
      })
      .partial()
      .optional(),
  })
  .loose()

function severityOf(type: string, declared: string | undefined): AlertSeverity {
  const event = type.toLowerCase()
  if (/(crashed|failed|oom)/.test(event)) return 'critical'
  const level = declared?.toLowerCase()
  if (level === 'critical' || level === 'warning' || level === 'notice' || level === 'info') return level
  if (/(alert|threshold|usage)/.test(event)) return 'warning'
  return 'info'
}

/** "Deployment.crashed" on service relay becomes "relay: deployment crashed". */
function summarize(type: string, service: string | undefined): string {
  const words = type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._]+/g, ' ')
    .trim()
    .toLowerCase()
  return service ? `${service}: ${words}` : words
}

/** Chat tools each want a different body for the same sentence. */
function forwardBody(url: string, text: string, event: unknown) {
  const host = new URL(url).hostname
  if (host.endsWith('feishu.cn') || host.endsWith('larksuite.com')) return { msg_type: 'text', content: { text } }
  if (host.endsWith('discord.com') || host.endsWith('discordapp.com')) return { content: text }
  return { text, event }
}

export function operationsRoutes(app: App, ctx: AppContext) {
  const guard = requireSession(ctx)
  const services = () => ctx.cache.get('railway.services', 20_000, () => requireRailway(ctx).services())

  app.get(`${API}/services`, guard, async (c) => {
    const railway = requireRailway(ctx)
    const [list, usage] = await Promise.all([
      services(),
      ctx.cache.get('railway.metrics.1', 30_000, () => railway.resourceMetrics(1)).catch(() => []),
    ])
    const latest = (serviceId: string, measurement: string) => {
      const series = usage.find((entry) => entry.serviceId === serviceId && entry.measurement === measurement)
      return series?.points.at(-1)?.value ?? null
    }
    return c.json({
      services: list.map((service) => ({
        ...service,
        cpu: latest(service.id, 'CPU_USAGE'),
        memoryGb: latest(service.id, 'MEMORY_USAGE_GB'),
        diskGb: latest(service.id, 'DISK_USAGE_GB'),
      })),
    })
  })

  // Relay samples are the console's own, so this page still has something to
  // show before Railway is connected; traffic and resources need the token.
  app.get(`${API}/metrics`, guard, async (c) => {
    const hours = hoursParam.parse(c.req.query('hours'))
    const railway = ctx.railway
    const list = railway ? await services() : []
    const gateway = list.find((service) => service.domains.length > 0)
    const [resources, http, relay] = await Promise.all([
      railway ? ctx.cache.get(`railway.metrics.${hours}`, 30_000, () => railway.resourceMetrics(hours)) : Promise.resolve([]),
      railway && gateway
        ? ctx.cache.get(`railway.http.${hours}`, 30_000, () => railway.httpTraffic(gateway.id, hours)).catch(() => null)
        : Promise.resolve(null),
      ctx.store
        ? ctx.store
            .samples(['relay.connections', 'relay.subscriptions', 'relay.events_per_minute', 'relay.rejections_per_minute'], hours)
            .catch(() => [])
        : Promise.resolve([]),
    ])
    return c.json({
      hours,
      railwayConnected: Boolean(railway),
      services: list.map((service) => ({ id: service.id, name: service.name })),
      resources,
      http: http ? { service: gateway!.name, ...http } : null,
      relay,
    })
  })

  app.get(`${API}/logs`, guard, async (c) => {
    const railway = requireRailway(ctx)
    const query = logsQuery.parse(c.req.query())
    const list = await services()
    let serviceId: string | undefined
    if (query.service) {
      serviceId = list.find((service) => service.name === query.service || service.id === query.service)?.id
      if (!serviceId) throw new ApiProblem(400, 'unknown_service', `No service named "${query.service}" in this environment.`)
    }
    const filter = [query.level ? `@level:${query.level}` : '', query.q ?? ''].filter(Boolean).join(' ')
    const lines = await railway.logs({ serviceId, filter, limit: query.limit, before: query.before })
    const names = new Map(list.map((service) => [service.id, service.name]))
    return c.json({
      services: list.map((service) => ({ id: service.id, name: service.name })),
      lines: lines.map((line) => ({ ...line, service: line.serviceId ? (names.get(line.serviceId) ?? null) : null })),
    })
  })

  app.get(`${API}/deployments`, guard, async (c) => {
    const railway = requireRailway(ctx)
    return c.json({ deployments: await ctx.cache.get('railway.deployments', 15_000, () => railway.deployments(60)) })
  })

  app.get(`${API}/alerts`, guard, async (c) => {
    const store = requireStore(ctx)
    const [alerts, open] = await Promise.all([store.alerts({ limit: 200 }), store.openAlertCount()])
    return c.json({ alerts, open, receiving: Boolean(ctx.config.WEBHOOK_TOKEN), forwarding: Boolean(ctx.config.ALERT_FORWARD_URL) })
  })

  app.post(`${API}/alerts/:id/acknowledge`, guard, async (c) => {
    const store = requireStore(ctx)
    const id = z.string().regex(/^\d+$/).parse(c.req.param('id'))
    const acknowledged = await store.acknowledgeAlert(id, c.get('session').sub)
    if (!acknowledged) throw new ApiProblem(404, 'alert_not_found', 'That alert does not exist or was already acknowledged.')
    return c.body(null, 204)
  })

  // Railway's project webhook. Deliveries are unsigned, so the secret is part
  // of the path; anything else gets the same 404 as an unknown route.
  app.post(`${BASE}/hooks/railway/:token`, async (c) => {
    const expected = ctx.config.WEBHOOK_TOKEN
    if (!expected || !safeEqual(c.req.param('token'), expected)) {
      return c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404)
    }
    const store = requireStore(ctx)
    const event = webhook.parse(await c.req.json())
    const service = event.resource?.service?.name
    const environment = event.resource?.environment?.name
    const severity = severityOf(event.type, event.severity)
    const summary = summarize(event.type, service)

    await store.addAlert({
      source: 'railway',
      type: event.type,
      severity,
      service: service ?? null,
      environment: environment ?? null,
      summary,
      payload: event as Record<string, unknown>,
    })
    ctx.log[severity === 'critical' ? 'error' : severity === 'warning' ? 'warn' : 'info'](
      { component: 'alerts', alert_type: event.type, alert_service: service, severity },
      `railway event: ${summary}`,
    )

    const forwardUrl = ctx.config.ALERT_FORWARD_URL
    if (forwardUrl && (severity === 'critical' || severity === 'warning')) {
      const text = `[${ctx.communityHost}] ${summary}${environment ? ` (${environment})` : ''}`
      // Answer Railway first; a slow chat webhook must not make it retry.
      void fetch(forwardUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardBody(forwardUrl, text, event)),
        signal: AbortSignal.timeout(8000),
      })
        .then((response) => {
          if (!response.ok) ctx.log.warn({ component: 'alerts', status: response.status }, 'alert forward was rejected')
        })
        .catch((error) => ctx.log.warn({ component: 'alerts', err: error }, 'alert forward failed'))
    }
    return c.json({ received: true })
  })
}
