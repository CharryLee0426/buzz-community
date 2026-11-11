import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Selector } from '@astryxdesign/core/Selector'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { ServiceLink } from '../components/ServiceLink'
import { StatusLabel } from '../components/StatusLabel'
import { useDeployments } from '../lib/queries'
import { deploymentStatus } from '../lib/status'
import type { Deployment } from '../lib/types'

type DeploymentRow = Deployment & Record<string, unknown>

const ALL = 'all'

const COLUMNS: TableColumn<DeploymentRow>[] = [
  {
    key: 'service',
    header: 'Service',
    width: proportional(2, { minWidth: 140 }),
    renderCell: (deployment) => <ServiceLink name={deployment.service} />,
  },
  {
    key: 'status',
    header: 'Outcome',
    width: proportional(2, { minWidth: 150 }),
    renderCell: (deployment) => {
      const status = deploymentStatus(deployment.status)
      // Only the newest deployment of a service is live; an older one was replaced by it.
      const label = deployment.status === 'REMOVED' ? 'Replaced' : deployment.status === 'REMOVING' ? 'Being replaced' : status.label
      return <StatusLabel variant={status.variant} label={label} isPulsing={status.active} />
    },
  },
  {
    key: 'source',
    header: 'Source',
    width: proportional(3, { minWidth: 180 }),
    renderCell: (deployment) => <Text color="secondary">{deployment.source ?? 'Configuration change'}</Text>,
  },
  {
    key: 'createdAt',
    header: 'Started',
    width: pixel(190),
    renderCell: (deployment) => <Timestamp value={deployment.createdAt} format="date_time" />,
  },
]

export default function DeploymentsPage() {
  const deployments = useDeployments()
  const [params, setParams] = useSearchParams()
  const service = params.get('service') ?? ALL

  const services = useMemo(
    () => [...new Set((deployments.data?.deployments ?? []).map((deployment) => deployment.service))].sort(),
    [deployments.data],
  )

  return (
    <Page
      title="Deployments"
      summary="The latest deployments of every service, newest first."
      toolbar={
        services.length > 1 ? (
          <Selector
            label="Service"
            isLabelHidden
            variant="secondary"
            options={[{ value: ALL, label: 'All services' }, ...services.map((name) => ({ value: name, label: name }))]}
            value={service}
            onChange={(value) => setParams(value === ALL ? {} : { service: value }, { replace: true })}
          />
        ) : undefined
      }>
      <QueryState query={deployments} skeletonRows={8}>
        {(data) => {
          const rows = service === ALL ? data.deployments : data.deployments.filter((deployment) => deployment.service === service)
          return rows.length === 0 ? (
            <EmptyState
              title={service === ALL ? 'No deployments yet' : `No deployments of ${service}`}
              description="A deployment appears here as soon as Railway starts one."
            />
          ) : (
            <Table<DeploymentRow> data={rows as DeploymentRow[]} columns={COLUMNS} idKey="id" hasHover textOverflow="truncate" />
          )
        }}
      </QueryState>
    </Page>
  )
}
