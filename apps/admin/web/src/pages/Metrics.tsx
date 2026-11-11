import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Grid } from '@astryxdesign/core/Grid'
import { VStack } from '@astryxdesign/core/Layout'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Heading } from '@astryxdesign/core/Text'
import { TimeChart } from '../components/charts'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { SERIES_COLORS, toMillis, toRows, type ChartSeries } from '../lib/chartData'
import { formatCount, formatCpu, formatGigabytes, formatRate } from '../lib/format'
import { useMetrics } from '../lib/queries'
import type { MetricsResponse } from '../lib/types'

const WINDOWS = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
]

// Response classes keep the colors people expect of them on every chart.
const STATUS_CLASSES: ChartSeries[] = [
  { key: '2xx', name: '2xx success', color: 'var(--color-data-categorical-teal)' },
  { key: '3xx', name: '3xx redirect', color: 'var(--color-data-categorical-blue)' },
  { key: '4xx', name: '4xx client error', color: 'var(--color-data-categorical-orange)' },
  { key: '5xx', name: '5xx server error', color: 'var(--color-data-categorical-red)' },
]

const milliseconds = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`)

/** One chart of a Railway measurement, with a line per service. */
function resourceChart(data: MetricsResponse, measurement: string) {
  // A service's color follows its position in the service list, so it is the same on every chart.
  const series: ChartSeries[] = []
  const lists: { key: string; points: { at: number; value: number }[] }[] = []
  data.services.forEach((service, index) => {
    const found = data.resources.find((entry) => entry.serviceId === service.id && entry.measurement === measurement)
    if (!found || !found.points.some((point) => point.value > 0)) return
    series.push({ key: service.id, name: service.name, color: SERIES_COLORS[index % SERIES_COLORS.length]! })
    lists.push({ key: service.id, points: found.points })
  })
  return { series, rows: toRows(lists) }
}

function relayChart(data: MetricsResponse, names: { sample: string; key: string }[]) {
  return toRows(
    names.map(({ sample, key }) => ({
      key,
      points: data.relay.filter((entry) => entry.name === sample),
    })),
  )
}

function statusRows(http: NonNullable<MetricsResponse['http']>) {
  // Railway reports each status code; four classes are what a person reads.
  const byClass = new Map<string, Map<number, number>>()
  for (const group of http.byStatus) {
    const key = `${Math.floor(group.status / 100)}xx`
    const points = byClass.get(key) ?? new Map<number, number>()
    for (const point of group.points) points.set(point.at, (points.get(point.at) ?? 0) + point.value)
    byClass.set(key, points)
  }
  return toRows([...byClass].map(([key, points]) => ({ key, points: [...points].map(([at, value]) => ({ at, value })) })))
}

function Charts({ data, asOf }: { data: MetricsResponse; asOf: number }) {
  const hours = data.hours
  const cpu = useMemo(() => resourceChart(data, 'CPU_USAGE'), [data])
  const memory = useMemo(() => resourceChart(data, 'MEMORY_USAGE_GB'), [data])
  const egress = useMemo(() => resourceChart(data, 'NETWORK_TX_GB'), [data])
  const disk = useMemo(() => resourceChart(data, 'DISK_USAGE_GB'), [data])
  const live = useMemo(
    () =>
      relayChart(data, [
        { sample: 'relay.connections', key: 'connections' },
        { sample: 'relay.subscriptions', key: 'subscriptions' },
      ]),
    [data],
  )
  const events = useMemo(
    () =>
      relayChart(data, [
        { sample: 'relay.events_per_minute', key: 'stored' },
        { sample: 'relay.rejections_per_minute', key: 'rejected' },
      ]),
    [data],
  )
  const statuses = useMemo(() => (data.http ? statusRows(data.http) : []), [data])
  const latency = useMemo(
    () => (data.http?.latency ?? []).map((point) => ({ at: toMillis(point.at), p50: point.p50, p95: point.p95, p99: point.p99 })),
    [data],
  )
  const waiting = 'The console samples the relay each minute. The first samples will appear shortly.'

  return (
    <VStack gap={8}>
      <VStack gap={3}>
        <Heading level={2}>Relay</Heading>
        <Grid columns={{ minWidth: 360, repeat: 'fit' }} gap={4}>
          <TimeChart
            title="Connections"
            caption="Open WebSocket connections and the subscriptions they hold."
            rows={live}
            series={[
              { key: 'connections', name: 'Connections', color: SERIES_COLORS[0]! },
              { key: 'subscriptions', name: 'Subscriptions', color: SERIES_COLORS[2]! },
            ]}
            windowHours={hours}
            asOf={asOf}
            formatValue={formatCount}
            isCount
            emptyText={waiting}
          />
          <TimeChart
            title="Events"
            caption="Messages and other events the relay stored or refused, per minute."
            rows={events}
            series={[
              { key: 'stored', name: 'Stored', color: SERIES_COLORS[3]! },
              { key: 'rejected', name: 'Refused', color: SERIES_COLORS[9]! },
            ]}
            windowHours={hours}
            asOf={asOf}
            formatValue={formatRate}
            emptyText={waiting}
          />
        </Grid>
      </VStack>

      {data.railwayConnected ? (
        <>
          <VStack gap={3}>
            <Heading level={2}>Traffic</Heading>
            {data.http ? (
              <Grid columns={{ minWidth: 360, repeat: 'fit' }} gap={4}>
                <TimeChart
                  title="Requests"
                  caption={`Requests reaching ${data.http.service}, by response class.`}
                  rows={statuses}
                  series={STATUS_CLASSES.filter((entry) => statuses.some((row) => typeof row[entry.key] === 'number'))}
                  windowHours={hours}
                  asOf={asOf}
                  formatValue={formatCount}
            isCount
                  emptyText="No requests in this window."
                />
                <TimeChart
                  title="Response time"
                  caption="How long requests took: the median, and the slowest 5% and 1%."
                  rows={latency}
                  series={[
                    { key: 'p50', name: 'Median', color: SERIES_COLORS[0]! },
                    { key: 'p95', name: '95th percentile', color: SERIES_COLORS[1]! },
                    { key: 'p99', name: '99th percentile', color: SERIES_COLORS[9]! },
                  ]}
                  windowHours={hours}
                  asOf={asOf}
                  formatValue={milliseconds}
                  emptyText="No requests in this window."
                />
              </Grid>
            ) : (
              <Banner
                status="info"
                title="No traffic figures"
                description="Railway measures HTTP traffic on services with a public domain, and none answered for this window."
              />
            )}
          </VStack>

          <VStack gap={3}>
            <Heading level={2}>Resources</Heading>
            <Grid columns={{ minWidth: 360, repeat: 'fit' }} gap={4}>
              <TimeChart title="CPU" caption="Cores in use, per service." rows={cpu.rows} series={cpu.series} windowHours={hours} asOf={asOf} formatValue={formatCpu} />
              <TimeChart
                title="Memory"
                caption="Resident memory, per service."
                rows={memory.rows}
                series={memory.series}
                windowHours={hours}
            asOf={asOf}
                formatValue={formatGigabytes}
              />
              <TimeChart
                title="Network out"
                caption="Data sent, per service. Railway bills egress."
                rows={egress.rows}
                series={egress.series}
                windowHours={hours}
            asOf={asOf}
                formatValue={formatGigabytes}
              />
              <TimeChart
                title="Volumes"
                caption="Disk in use by services that keep data: Postgres and Redis."
                rows={disk.rows}
                series={disk.series}
                windowHours={hours}
            asOf={asOf}
                formatValue={formatGigabytes}
              />
            </Grid>
          </VStack>
        </>
      ) : (
        <Banner
          status="info"
          title="Traffic and resource charts need Railway"
          description="Create a project token in Railway and set it as RAILWAY_API_TOKEN on the admin service. Relay activity above is sampled by this console and works without it."
          endContent={<Button label="Open settings" href="/settings" variant="secondary" size="sm" />}
        />
      )}
    </VStack>
  )
}

export default function MetricsPage() {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('hours'))
  const hours = WINDOWS.some((entry) => entry.hours === requested) ? requested : 6
  const metrics = useMetrics(hours)

  return (
    <Page
      title="Metrics"
      summary={
        metrics.isPlaceholderData
          ? `Loading the last ${WINDOWS.find((entry) => entry.hours === hours)!.label}…`
          : 'Relay activity sampled by this console, with traffic and resource usage from Railway.'
      }
      actions={
        <SegmentedControl
          label="Time window"
          value={String(hours)}
          onChange={(value) => setParams(value === '6' ? {} : { hours: value }, { replace: true })}>
          {WINDOWS.map((entry) => (
            <SegmentedControlItem key={entry.hours} value={String(entry.hours)} label={entry.label} />
          ))}
        </SegmentedControl>
      }>
      <QueryState query={metrics} skeletonRows={8}>
        {(data) => <Charts data={data} asOf={metrics.dataUpdatedAt} />}
      </QueryState>
    </Page>
  )
}
