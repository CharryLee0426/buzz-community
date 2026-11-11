import type { AppContext } from './context.js'
import { readRelayMetrics, type RelayMetrics } from './relay/status.js'

// Railway does not scrape Prometheus endpoints, so the relay's own gauges
// would be invisible without this: once a minute the console reads the relay's
// private metrics port and keeps a short history in its own tables.

export interface LiveRelay {
  sampledAt: string
  connections: number | null
  authenticatedConnections: number | null
  subscriptions: number | null
  dbPool: RelayMetrics['dbPool']
  /** Per-minute rates derived from the relay's counters. Null until two samples exist. */
  rates: { eventsStored: number; eventsRejected: number; authFailures: number; httpServerErrors: number } | null
}

export interface Collector {
  latest(): LiveRelay | null
  start(): void
  stop(): void
}

const INTERVAL_MS = 60_000
const RETENTION_DAYS = 14

export function createCollector(ctx: AppContext): Collector {
  let latest: LiveRelay | null = null
  let previous: { at: number; counters: RelayMetrics['counters'] } | null = null
  let timer: NodeJS.Timeout | undefined
  let lastPrune = 0
  let failures = 0

  async function sample() {
    const metricsUrl = ctx.config.RELAY_METRICS_URL
    if (!metricsUrl) return
    try {
      const metrics = await readRelayMetrics(metricsUrl)
      const now = Date.now()
      let rates: LiveRelay['rates'] = null
      if (previous) {
        const minutes = (now - previous.at) / 60_000
        // A counter that went backwards means the relay restarted; skip that interval.
        const rate = (key: keyof RelayMetrics['counters']) => {
          const delta = metrics.counters[key] - previous!.counters[key]
          return delta >= 0 && minutes > 0 ? delta / minutes : 0
        }
        rates = {
          eventsStored: rate('eventsStored'),
          eventsRejected: rate('eventsRejected'),
          authFailures: rate('authFailures'),
          httpServerErrors: rate('httpServerErrors'),
        }
      }
      previous = { at: now, counters: metrics.counters }
      latest = {
        sampledAt: new Date(now).toISOString(),
        connections: metrics.connections,
        authenticatedConnections: metrics.authenticatedConnections,
        subscriptions: metrics.subscriptions,
        dbPool: metrics.dbPool,
        rates,
      }

      if (ctx.store) {
        const samples = [
          { name: 'relay.connections', value: metrics.connections },
          { name: 'relay.subscriptions', value: metrics.subscriptions },
          { name: 'relay.events_per_minute', value: rates?.eventsStored ?? null },
          { name: 'relay.rejections_per_minute', value: rates?.eventsRejected ?? null },
        ].filter((entry): entry is { name: string; value: number } => entry.value !== null)
        await ctx.store.recordSamples(samples)
        if (now - lastPrune > 6 * 3_600_000) {
          lastPrune = now
          await ctx.store.pruneSamples(RETENTION_DAYS)
        }
      }
      if (failures > 0) ctx.log.info({ component: 'collector' }, 'relay metrics are readable again')
      failures = 0
    } catch (error) {
      failures += 1
      // One line when it starts failing, then a reminder every ten minutes.
      if (failures === 1 || failures % 10 === 0) {
        ctx.log.warn({ component: 'collector', err: error, consecutive_failures: failures }, 'could not read relay metrics')
      }
    }
  }

  return {
    latest: () => latest,
    start() {
      if (timer) return
      void sample()
      timer = setInterval(() => void sample(), INTERVAL_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
