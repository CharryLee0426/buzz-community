import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack, Layout, LayoutContent, StackItem, VStack } from '@astryxdesign/core/Layout'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { ChevronRightIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { StatusLabel } from '../components/StatusLabel'
import { formatLogTime, plural } from '../lib/format'
import { useLogs, type LogFilters } from '../lib/queries'
import type { StatusView } from '../lib/status'
import type { LogLine } from '../lib/types'

type LogRow = LogLine & { key: string } & Record<string, unknown>

const ALL = 'all'
const LEVELS = ['error', 'warn', 'info']
const SEARCH_PAUSE_MS = 450

function levelOf(severity: string): StatusView {
  switch (severity) {
    case 'error':
    case 'fatal':
    case 'critical':
      return { variant: 'error', label: 'Error' }
    case 'warn':
    case 'warning':
      return { variant: 'warning', label: 'Warn' }
    case 'debug':
    case 'trace':
      return { variant: 'neutral', label: 'Debug' }
    default:
      return { variant: 'accent', label: 'Info' }
  }
}

/**
 * Newest first, with a key that belongs to the line and not to its position:
 * a live tail prepends lines every few seconds, and rows must keep their
 * identity (and keyboard focus) when it does.
 */
function toRows(lines: LogLine[]): LogRow[] {
  const seen = new Map<string, number>()
  const rows = lines.map((line) => {
    const base = `${line.timestamp}|${line.serviceId ?? ''}|${line.message}`
    const repeat = seen.get(base) ?? 0
    seen.set(base, repeat + 1)
    return { ...line, key: repeat === 0 ? base : `${base}|${repeat}` }
  })
  return rows.reverse()
}

function LineDrawer({ line, onClose }: { line: LogRow | null; onClose: () => void }) {
  const fields = line ? Object.entries(line.attributes).filter(([key]) => key !== 'level' && key !== 'message') : []
  return (
    <Drawer isOpen={line !== null} onOpenChange={(open) => !open && onClose()} label="Log line" width={520}>
      {line ? (
        <Layout
          header={<DrawerHeader title="Log line" onOpenChange={onClose} />}
          content={
            <LayoutContent>
              <VStack gap={5}>
                <CodeBlock code={line.message} width="100%" isWrapped />
                <MetadataList>
                  <MetadataListItem label="Time">
                    <Timestamp value={line.timestamp} format="system_date_time" isTimezoneShown color="primary" type="body" />
                  </MetadataListItem>
                  <MetadataListItem label="Service">{line.service ?? 'Unknown'}</MetadataListItem>
                  <MetadataListItem label="Level">{levelOf(line.severity).label}</MetadataListItem>
                  {line.deploymentId ? (
                    <MetadataListItem label="Deployment">
                      <Text type="code" size="sm">
                        {line.deploymentId}
                      </Text>
                    </MetadataListItem>
                  ) : null}
                </MetadataList>
                {fields.length > 0 ? (
                  <CodeBlock title="Fields" language="json" code={JSON.stringify(Object.fromEntries(fields), null, 2)} width="100%" isWrapped hasLanguageLabel={false} />
                ) : null}
              </VStack>
            </LayoutContent>
          }
        />
      ) : null}
    </Drawer>
  )
}

export default function LogsPage() {
  const [params, setParams] = useSearchParams()
  const service = params.get('service') ?? ALL
  const requestedLevel = params.get('level') ?? ALL
  const level = LEVELS.includes(requestedLevel) ? requestedLevel : ALL
  const q = params.get('q') ?? ''

  // What is typed, ahead of the `q` it becomes once the operator pauses.
  const [search, setSearch] = useState({ text: q, for: q })
  // `q` also changes without typing: a link here, or Back. Then the box follows it.
  if (search.for !== q) setSearch({ text: q, for: q })
  const [isLive, setIsLive] = useState(true)
  const [selected, setSelected] = useState<LogRow | null>(null)

  const setFilter = (name: 'service' | 'level' | 'q', value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value === '' || value === ALL) next.delete(name)
        else next.set(name, value)
        return next
      },
      { replace: true },
    )

  // Search once typing pauses, so each keystroke is not a Railway query.
  useEffect(() => {
    const term = search.text.trim()
    if (term === q) return
    const timer = window.setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (term) next.set('q', term)
          else next.delete('q')
          return next
        },
        { replace: true },
      )
    }, SEARCH_PAUSE_MS)
    return () => window.clearTimeout(timer)
  }, [search.text, q, setParams])

  const filters: LogFilters = useMemo(
    () => ({ service: service === ALL ? undefined : service, level: level === ALL ? undefined : level, q: q || undefined }),
    [service, level, q],
  )
  // A line being read should not scroll away, so the tail pauses while one is open.
  const logs = useLogs(filters, isLive && selected === null)
  const rows = useMemo(() => toRows(logs.data?.lines ?? []), [logs.data])

  const columns: TableColumn<LogRow>[] = [
    {
      key: 'timestamp',
      header: 'Time',
      width: pixel(150),
      renderCell: (line) => (
        <Text type="code" size="sm" color="secondary" hasTabularNumbers>
          {formatLogTime(line.timestamp)}
        </Text>
      ),
    },
    {
      key: 'service',
      header: 'Service',
      width: pixel(110),
      renderCell: (line) => <Text color="secondary">{line.service ?? '—'}</Text>,
    },
    {
      key: 'severity',
      header: 'Level',
      width: pixel(96),
      renderCell: (line) => {
        const shown = levelOf(line.severity)
        return <StatusLabel variant={shown.variant} label={shown.label} />
      },
    },
    {
      key: 'message',
      header: 'Message',
      width: proportional(1, { minWidth: 320 }),
      renderCell: (line) => (
        <Text type="code" size="sm" maxLines={1} hasTruncateTooltip={false}>
          {line.message}
        </Text>
      ),
    },
    {
      key: 'open',
      header: '',
      width: pixel(64),
      align: 'end',
      renderCell: (line) => (
        <IconButton
          label={`Show the whole line from ${formatLogTime(line.timestamp)}`}
          icon={<Icon icon={ChevronRightIcon} />}
          variant="ghost"
          size="sm"
          onClick={() => setSelected(line)}
        />
      ),
    },
  ]

  const services = logs.data?.services ?? []
  const isFiltered = service !== ALL || level !== ALL || q !== ''
  // The table still shows the previous filter's lines while the new ones load.
  const isSearching = logs.isPlaceholderData || search.text.trim() !== q

  return (
    <Page
      title="Logs"
      summary={
        isSearching
          ? 'Loading matching lines…'
          : logs.data
            ? `The newest ${plural(rows.length, 'line')} from Railway${isFiltered ? ' that match' : ''}.`
            : 'Structured logs from every service, read from Railway.'
      }
      actions={<Switch label="Live" value={isLive} onChange={setIsLive} labelPosition="start" />}
      toolbar={
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Selector
            label="Service"
            isLabelHidden
            variant="secondary"
            options={[{ value: ALL, label: 'All services' }, ...services.map((entry) => ({ value: entry.name, label: entry.name }))]}
            value={service}
            onChange={(value) => setFilter('service', value)}
          />
          <SegmentedControl label="Level" value={level} onChange={(value) => setFilter('level', value)}>
            <SegmentedControlItem value={ALL} label="All levels" />
            {LEVELS.map((entry) => (
              <SegmentedControlItem key={entry} value={entry} label={levelOf(entry).label} />
            ))}
          </SegmentedControl>
          <StackItem size="fill">
            <TextInput
              label="Filter"
              isLabelHidden
              placeholder="Text to find, or a Railway filter such as @status:500"
              value={search.text}
              onChange={(text) => setSearch({ text, for: q })}
              startIcon={MagnifyingGlassIcon}
              isLoading={isSearching}
              hasClear
              hasSpellCheck={false}
              width="100%"
            />
          </StackItem>
        </HStack>
      }>
      <QueryState query={logs} skeletonRows={12}>
        {() =>
          rows.length === 0 ? (
            <EmptyState
              title={isFiltered ? 'No lines match these filters' : 'No logs yet'}
              description={
                isFiltered
                  ? 'Railway keeps logs for a limited time, and a filter only searches what it still has.'
                  : 'Lines appear here as services write them.'
              }
            />
          ) : (
            <Table<LogRow> data={rows} columns={columns} idKey="key" density="compact" hasHover textOverflow="truncate" />
          )
        }
      </QueryState>
      <LineDrawer line={selected} onClose={() => setSelected(null)} />
    </Page>
  )
}
