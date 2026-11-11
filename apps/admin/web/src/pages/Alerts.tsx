import { useSearchParams } from 'react-router'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/Layout'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { useToast } from '@astryxdesign/core/Toast'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { StatusLabel } from '../components/StatusLabel'
import { errorMessage } from '../lib/errors'
import { plural } from '../lib/format'
import { useAcknowledgeAlert, useAlerts } from '../lib/queries'
import { SEVERITY } from '../lib/status'
import type { AlertRecord } from '../lib/types'

type AlertRow = AlertRecord & Record<string, unknown>

function AlertsTable({ alerts }: { alerts: AlertRecord[] }) {
  const acknowledge = useAcknowledgeAlert()
  const showToast = useToast()

  const columns: TableColumn<AlertRow>[] = [
    {
      key: 'summary',
      header: 'What happened',
      width: proportional(4, { minWidth: 260 }),
      renderCell: (alert) => {
        const where = [alert.service, alert.environment].filter(Boolean).join(' · ')
        return (
          <VStack gap={0}>
            <Text weight={alert.acknowledgedAt ? 'normal' : 'medium'} maxLines={1}>
              {alert.summary}
            </Text>
            {where ? (
              <Text type="supporting" maxLines={1}>
                {where}
              </Text>
            ) : null}
          </VStack>
        )
      },
    },
    {
      key: 'severity',
      header: 'Severity',
      width: pixel(130),
      renderCell: (alert) => <StatusLabel variant={SEVERITY[alert.severity].variant} label={SEVERITY[alert.severity].label} />,
    },
    {
      key: 'receivedAt',
      header: 'Received',
      width: pixel(150),
      renderCell: (alert) => <Timestamp value={alert.receivedAt} format="relative" isLive />,
    },
    {
      key: 'acknowledged',
      header: 'Handled',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (alert) =>
        alert.acknowledgedAt ? (
          <Text color="secondary" maxLines={1}>
            {alert.acknowledgedBy ? `Acknowledged by ${alert.acknowledgedBy}` : 'Recorded, no action needed'}
          </Text>
        ) : (
          <Button
            // Named for its row, so a screen reader hears which alert each button acknowledges.
            label={`Acknowledge: ${alert.summary}`}
            size="sm"
            variant="secondary"
            isLoading={acknowledge.isPending && acknowledge.variables?.id === alert.id}
            onClick={() => acknowledge.mutate({ id: alert.id }, { onError: (error) => showToast({ body: errorMessage(error), type: 'error' }) })}>
            Acknowledge
          </Button>
        ),
    },
  ]

  return <Table<AlertRow> data={alerts as AlertRow[]} columns={columns} idKey="id" hasHover textOverflow="truncate" />
}

export default function AlertsPage() {
  const alerts = useAlerts()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'all' ? 'all' : 'open'
  const open = alerts.data?.open

  return (
    <Page
      title="Alerts"
      summary={
        open === undefined
          ? 'Crashes, failed deployments and usage alerts from Railway.'
          : open === 0
            ? 'Nothing is waiting for you.'
            : `${plural(open, 'alert')} waiting to be acknowledged.`
      }
      toolbar={
        <SegmentedControl label="Which alerts to show" value={view} onChange={(value) => setParams(value === 'all' ? { view: 'all' } : {}, { replace: true })}>
          <SegmentedControlItem value="open" label="Open" />
          <SegmentedControlItem value="all" label="All" />
        </SegmentedControl>
      }>
      <QueryState query={alerts}>
        {(data) => {
          const rows = view === 'open' ? data.alerts.filter((alert) => !alert.acknowledgedAt) : data.alerts
          return (
            <VStack gap={4}>
              {data.receiving ? null : (
                <Banner
                  status="warning"
                  title="Railway is not sending events here"
                  description="This console has no webhook secret, so crashes and failed deployments cannot reach it. Run the setup script again to generate one."
                  endContent={<Button label="Open settings" href="/settings" variant="secondary" size="sm" />}
                />
              )}
              {rows.length === 0 ? (
                <EmptyState
                  title={view === 'open' ? 'No open alerts' : 'No alerts received yet'}
                  description={
                    data.forwarding
                      ? 'Railway reports crashes, failed deployments and usage alerts here. Critical and warning alerts are also forwarded to your chat webhook.'
                      : 'Railway reports crashes, failed deployments and usage alerts here.'
                  }
                  actions={
                    view === 'open' && data.alerts.length > 0 ? (
                      <Button label="Show all alerts" variant="secondary" onClick={() => setParams({ view: 'all' }, { replace: true })} />
                    ) : undefined
                  }
                />
              ) : (
                <AlertsTable alerts={rows} />
              )}
            </VStack>
          )
        }}
      </QueryState>
    </Page>
  )
}
