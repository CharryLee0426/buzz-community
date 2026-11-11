import { describe, expect, it } from 'vitest'
import { stepSecondsFor } from '../railway/client.js'
import { cleanRefusal } from './client.js'
import { parsePrometheus, summarizeMetrics } from './status.js'

const EXPOSITION = `
# HELP buzz_ws_connections_active Active WebSocket connections
# TYPE buzz_ws_connections_active gauge
buzz_ws_connections_active 7
buzz_ws_authenticated_connections_active 5
buzz_subscriptions_active 42
buzz_events_stored_total{kind="9",author_type="human"} 120
buzz_events_stored_total{kind="7",author_type="human"} 30
buzz_events_rejected_total{transport="ws",reason="rate \\"limited\\""} 3
buzz_auth_failures_total{reason="expired"} 2
http_requests_total{code="200",caller="unknown",action="/events"} 900
http_requests_total{code="503",caller="unknown",action="/query"} 4
buzz_db_pool_connections{pool_role="writer",state="active"} 2
buzz_db_pool_connections{pool_role="writer",state="idle"} 6
buzz_db_pool_connections{pool_role="reader",state="active"} 9
buzz_db_pool_max_connections{pool_role="writer"} 20
this line is not a metric
buzz_bad_value NaN
`

describe('prometheus parsing', () => {
  it('reads names, labels and values and skips the rest', () => {
    const points = parsePrometheus(EXPOSITION)
    expect(points.find((point) => point.name === 'buzz_ws_connections_active')).toEqual({
      name: 'buzz_ws_connections_active',
      labels: {},
      value: 7,
    })
    const rejected = points.find((point) => point.name === 'buzz_events_rejected_total')
    expect(rejected?.labels).toEqual({ transport: 'ws', reason: 'rate "limited"' })
    expect(points.some((point) => point.name === 'buzz_bad_value')).toBe(false)
    expect(points.some((point) => point.name === 'this')).toBe(false)
  })

  it('summarizes what the console shows', () => {
    const summary = summarizeMetrics(parsePrometheus(EXPOSITION))
    expect(summary.connections).toBe(7)
    expect(summary.authenticatedConnections).toBe(5)
    expect(summary.subscriptions).toBe(42)
    expect(summary.dbPool).toEqual({ active: 2, idle: 6, max: 20 })
    expect(summary.counters).toEqual({
      eventsStored: 150,
      eventsRejected: 3,
      authFailures: 2,
      httpRequests: 904,
      httpServerErrors: 4,
    })
  })

  it('reports absent gauges as unknown, not zero', () => {
    const summary = summarizeMetrics([])
    expect(summary.connections).toBeNull()
    expect(summary.dbPool.max).toBeNull()
    expect(summary.counters.eventsStored).toBe(0)
  })
})

describe('helpers', () => {
  it('turns relay refusals into plain sentences', () => {
    expect(cleanRefusal('invalid: cannot change your own role')).toBe('Cannot change your own role')
    expect(cleanRefusal('restricted: banned')).toBe('Banned')
    expect(cleanRefusal(undefined)).toBe('The relay refused the request.')
  })

  it('keeps charts near 120 points for any window', () => {
    expect(stepSecondsFor(1)).toBe(60)
    expect(stepSecondsFor(6)).toBe(300)
    expect(stepSecondsFor(24)).toBe(900)
    expect(stepSecondsFor(168)).toBe(7200)
  })
})
