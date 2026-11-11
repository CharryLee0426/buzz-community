import { VStack } from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { ServiceLink } from '../components/ServiceLink'
import { StatusLabel } from '../components/StatusLabel'
import { formatCount, formatCpu, formatGigabytes } from '../lib/format'
import { useServices } from '../lib/queries'
import { deploymentStatus } from '../lib/status'
import type { ServiceUsage } from '../lib/types'

type ServiceRow = ServiceUsage & Record<string, unknown>

/** Where a service's code comes from, short enough for a table cell. */
function sourceOf(service: ServiceUsage) {
  if (service.repo) return service.repo
  if (!service.image) return null
  // ghcr.io/block/buzz:sha-47674dc reads as buzz:sha-47674dc; the registry path adds nothing here.
  return service.image.split('/').at(-1) ?? service.image
}

const measure = (value: number | null, format: (value: number) => string) =>
  value === null ? <Text color="secondary">—</Text> : <Text hasTabularNumbers>{format(value)}</Text>

const COLUMNS: TableColumn<ServiceRow>[] = [
  {
    key: 'name',
    header: 'Service',
    width: proportional(3, { minWidth: 200 }),
    renderCell: (service) => {
      const source = sourceOf(service)
      return (
        <VStack gap={0}>
          <ServiceLink name={service.name} />
          {source ? (
            <Text type="supporting" maxLines={1}>
              {source}
            </Text>
          ) : null}
        </VStack>
      )
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: proportional(2, { minWidth: 140 }),
    renderCell: (service) => {
      const status = deploymentStatus(service.deployment?.status)
      return <StatusLabel variant={status.variant} label={status.label} isPulsing={status.active} />
    },
  },
  { key: 'cpu', header: 'CPU', width: pixel(110), align: 'end', renderCell: (service) => measure(service.cpu, formatCpu) },
  { key: 'memoryGb', header: 'Memory', width: pixel(100), align: 'end', renderCell: (service) => measure(service.memoryGb, formatGigabytes) },
  { key: 'diskGb', header: 'Volume', width: pixel(100), align: 'end', renderCell: (service) => measure(service.diskGb, formatGigabytes) },
  {
    key: 'domains',
    header: 'Public address',
    width: proportional(2, { minWidth: 170 }),
    renderCell: (service) => {
      const domain = service.domains.find((entry) => entry.kind === 'custom') ?? service.domains[0]
      if (!domain) return <Text color="secondary">Private network only</Text>
      return (
        <Link href={`https://${domain.domain}`} isExternalLink color="primary">
          {domain.domain}
        </Link>
      )
    },
  },
  {
    key: 'deployed',
    header: 'Deployed',
    width: pixel(140),
    renderCell: (service) =>
      service.deployment ? <Timestamp value={service.deployment.createdAt} format="relative" isLive /> : <Text color="secondary">Never</Text>,
  },
]

export default function ServicesPage() {
  const services = useServices()
  const running = services.data?.services.filter((service) => service.deployment?.status === 'SUCCESS').length

  return (
    <Page
      title="Services"
      summary={
        services.data
          ? `${formatCount(running ?? 0)} of ${formatCount(services.data.services.length)} running on Railway. Usage is the latest reading.`
          : 'Everything this community runs on Railway.'
      }>
      <QueryState query={services} skeletonRows={7}>
        {(data) => <Table<ServiceRow> data={data.services as ServiceRow[]} columns={COLUMNS} idKey="id" hasHover textOverflow="truncate" />}
      </QueryState>
    </Page>
  )
}
