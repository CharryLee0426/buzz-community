import { useMemo } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack, LayoutPanel, StackItem, VStack } from '@astryxdesign/core/Layout'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { useMediaQuery } from '@astryxdesign/core/hooks'
import { TimeChart } from '../components/charts'
import { Page } from '../components/Page'
import { ServiceLink } from '../components/ServiceLink'
import { Stat } from '../components/Stat'
import { StatusLabel } from '../components/StatusLabel'
import { SERIES_COLORS, toRows } from '../lib/chartData'
import { describeError } from '../lib/errors'
import { formatCompact, formatCount, formatDuration, plural } from '../lib/format'
import { useOverview } from '../lib/queries'
import { deploymentStatus, SEVERITY } from '../lib/status'
import type { AlertRecord, Overview, ServiceInfo } from '../lib/types'

type ServiceRow = ServiceInfo & Record<string, unknown>

const STAT_LABELS = ['People', 'Agents', 'Channels', 'Messages', 'Connected now']
const WAITING_FOR_SAMPLES = 'The console samples the relay each minute. The first samples will appear shortly.'

const SERVICE_COLUMNS: TableColumn<ServiceRow>[] = [
  {
    key: 'name',
    header: 'Service',
    width: proportional(2, { minWidth: 120 }),
    renderCell: (service) => <ServiceLink name={service.name} />,
  },
  {
    key: 'status',
    header: 'Status',
    width: proportional(2, { minWidth: 130 }),
    renderCell: (service) => {
      const status = deploymentStatus(service.deployment?.status)
      return <StatusLabel variant={status.variant} label={status.label} isPulsing={status.active} />
    },
  },
  {
    key: 'deployed',
    header: 'Deployed',
    width: pixel(150),
    renderCell: (service) =>
      service.deployment ? <Timestamp value={service.deployment.createdAt} format="relative" isLive /> : <Text color="secondary">Never</Text>,
  },
]

function relaySummary({ relay }: Overview) {
  if (!relay.reachable) return 'The relay is not answering.'
  const parts = [`Relay ${relay.version ?? ''}${relay.build ? ` (${relay.build})` : ''}`.trim()]
  if (relay.uptimeSeconds !== null) parts.push(`up ${formatDuration(relay.uptimeSeconds)}`)
  // Unknown is not the same as open: say nothing when the relay did not report it.
  if (relay.membershipRequired !== null) parts.push(relay.membershipRequired ? 'invite-only' : 'open to anyone')
  return parts.join(' · ')
}

/** What stops the community working, as one notice: the most severe first. */
function relayProblem({ relay }: Overview): { title: string; description: string } | null {
  if (!relay.reachable) {
    return {
      title: 'The relay is not answering',
      description: `Members cannot connect until it is back. Check the relay service’s deployment and logs.${relay.error ? ` (${relay.error})` : ''}`,
    }
  }
  const found: { title: string; description: string }[] = []
  if (relay.dependencies.postgres === false) {
    found.push({ title: 'The relay cannot reach Postgres', description: 'Messages cannot be stored or read until the database is back.' })
  }
  if (relay.dependencies.redis === false) {
    found.push({ title: 'The relay cannot reach Redis', description: 'Sign-in checks and rate limits fail closed, so writes are refused until Redis is back.' })
  }
  if (relay.partitionsServingSafe === false) {
    found.push({ title: 'Message partitions need attention', description: 'The relay reports its event partitions are not safe to serve. See the relay logs for the partition audit.' })
  }
  if (found.length <= 1) return found[0] ?? null
  return { title: 'The relay is degraded', description: found.map((problem) => `${problem.title}. ${problem.description}`).join(' ') }
}

function AlertRow({ alert }: { alert: AlertRecord }) {
  const severity = SEVERITY[alert.severity]
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <StatusLabel variant={severity.variant} label={severity.label} />
        </StackItem>
        <Timestamp value={alert.receivedAt} format="relative" isLive />
      </HStack>
      <Text maxLines={2}>{alert.summary}</Text>
    </VStack>
  )
}

function AlertsRail({ overview }: { overview: Overview }) {
  const { open, recent } = overview.alerts
  return (
    <VStack gap={4}>
      <HStack vAlign="center" gap={2}>
        <StackItem size="fill">
          <Heading level={2}>Open alerts</Heading>
        </StackItem>
        {open > 0 ? <Button label="Review all" href="/alerts" variant="ghost" size="sm" /> : null}
      </HStack>
      {recent.length === 0 ? (
        <EmptyState
          isCompact
          title="Nothing needs attention"
          description="Crashed or failed deployments and usage alerts from Railway appear here."
        />
      ) : (
        <VStack gap={4}>
          {recent.map((alert, index) => (
            <VStack gap={4} key={alert.id}>
              {index > 0 ? <Divider /> : null}
              <AlertRow alert={alert} />
            </VStack>
          ))}
          {open > recent.length ? <Text type="supporting">And {formatCount(open - recent.length)} more.</Text> : null}
        </VStack>
      )}
    </VStack>
  )
}

function Services({ overview }: { overview: Overview }) {
  if (overview.services) {
    return <Table<ServiceRow> data={overview.services as ServiceRow[]} columns={SERVICE_COLUMNS} idKey="id" density="compact" textOverflow="truncate" />
  }
  if (!overview.railwayConnected) {
    return (
      <EmptyState
        isCompact
        title="Railway is not connected"
        description="Connect it to see each service’s status here, and its logs, metrics and deployments on their own pages."
        actions={<Button label="Open settings" href="/settings" variant="secondary" />}
      />
    )
  }
  return (
    <EmptyState
      isCompact
      title="Service status could not be read"
      description={overview.servicesError ?? 'Railway did not answer.'}
      actions={<Button label="Open Services" href="/services" variant="secondary" />}
    />
  )
}

export default function OverviewPage() {
  const query = useOverview()
  const overview = query.data
  const isWide = useMediaQuery('(min-width: 1180px)')

  const messageRows = useMemo(
    () => toRows([{ key: 'messages', points: (overview?.messages ?? []).map((point) => ({ at: point.at, value: point.messages })) }]),
    [overview?.messages],
  )
  const connectionRows = useMemo(
    () => toRows([{ key: 'connections', points: (overview?.samples ?? []).filter((sample) => sample.name === 'relay.connections') }]),
    [overview?.samples],
  )

  if (!overview) {
    const problem = query.isError ? describeError(query.error) : null
    return (
      <Page title="Overview">
        {problem ? (
          <EmptyState
            title={problem.title}
            description={problem.description}
            actions={
              problem.action ? (
                <Button label={problem.action.label} href={problem.action.href} variant="secondary" />
              ) : (
                <Button label="Retry" variant="secondary" isLoading={query.isFetching} onClick={() => query.refetch()} />
              )
            }
          />
        ) : (
          <Grid columns={{ minWidth: 150, repeat: 'fit' }} gap={6}>
            {STAT_LABELS.map((label) => (
              <Stat key={label} label={label} value={null} />
            ))}
          </Grid>
        )}
      </Page>
    )
  }

  const { counts, live } = overview
  const asOf = Date.parse(overview.generatedAt)
  const figure = (value: number | null | undefined) => (typeof value === 'number' ? formatCompact(value) : undefined)
  const problem = relayProblem(overview)
  const rail = <AlertsRail overview={overview} />

  return (
    <Page
      title="Overview"
      summary={relaySummary(overview)}
      actions={
        <Text type="supporting">
          {query.isError ? 'Refresh failed. Last updated ' : 'Updated '}
          <Timestamp value={overview.generatedAt} format="relative" isLive />
        </Text>
      }
      panel={
        isWide ? (
          <LayoutPanel width={340} hasDivider padding={6} role="complementary" label="Open alerts">
            {rail}
          </LayoutPanel>
        ) : undefined
      }>
      <VStack gap={8}>
        {problem ? <Banner status="error" title={problem.title} description={problem.description} /> : null}
        {overview.countsError ? (
          <Banner status="warning" title="Community figures are unavailable" description={overview.countsError} />
        ) : null}

        <Grid columns={{ minWidth: 150, repeat: 'fit' }} gap={6}>
          <Stat label="People" value={figure(counts?.people)} detail={counts ? `${formatCount(counts.admins)} with admin rights` : undefined} />
          <Stat label="Agents" value={figure(counts?.agents)} detail={counts ? 'hosted here or in members’ apps' : undefined} />
          <Stat
            label="Channels"
            value={counts ? figure(counts.openChannels + counts.privateChannels) : undefined}
            detail={counts ? `${formatCount(counts.openChannels)} open, ${formatCount(counts.privateChannels)} private` : undefined}
          />
          <Stat
            label="Messages"
            value={figure(counts?.messages24h)}
            detail={counts ? `last 24 hours, from ${plural(counts.activeAuthors24h, 'author')}` : undefined}
          />
          <Stat
            label="Connected now"
            value={figure(live?.connections)}
            detail={live ? plural(live.subscriptions ?? 0, 'subscription') : 'waiting for the first sample'}
          />
        </Grid>

        <Grid columns={{ minWidth: 340, repeat: 'fit' }} gap={4}>
          <TimeChart
            title="Messages"
            caption="Per hour, across open and private channels."
            rows={messageRows}
            series={[{ key: 'messages', name: 'Messages', color: SERIES_COLORS[0]! }]}
            windowHours={24}
            asOf={asOf}
            formatValue={formatCount}
            isCount
          />
          <TimeChart
            title="Connections"
            caption="WebSocket connections to the relay, sampled each minute."
            rows={connectionRows}
            series={[{ key: 'connections', name: 'Connections', color: SERIES_COLORS[3]! }]}
            windowHours={24}
            asOf={asOf}
            formatValue={formatCount}
            isCount
            emptyText={WAITING_FOR_SAMPLES}
          />
        </Grid>

        <VStack gap={3}>
          <Heading level={2}>Services</Heading>
          <Services overview={overview} />
        </VStack>

        {isWide ? null : (
          <>
            <Divider />
            {rail}
          </>
        )}
      </VStack>
    </Page>
  )
}
