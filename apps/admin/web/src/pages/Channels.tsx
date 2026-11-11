import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/Layout'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { StatusLabel } from '../components/StatusLabel'
import { formatCount, plural } from '../lib/format'
import { useChannels } from '../lib/queries'
import type { Channel } from '../lib/types'

type ChannelRow = Channel & Record<string, unknown>

const TYPE_LABEL: Record<Channel['type'], string> = { stream: 'Chat', forum: 'Forum' }

const COLUMNS: TableColumn<ChannelRow>[] = [
  {
    key: 'name',
    header: 'Channel',
    width: proportional(3, { minWidth: 220 }),
    renderCell: (channel) => (
      <VStack gap={0}>
        <Text weight="medium" maxLines={1}>
          {channel.name}
        </Text>
        {channel.description ? (
          <Text type="supporting" maxLines={1}>
            {channel.description}
          </Text>
        ) : null}
      </VStack>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    width: pixel(100),
    renderCell: (channel) => <Text color="secondary">{TYPE_LABEL[channel.type]}</Text>,
  },
  {
    key: 'state',
    header: 'Joining',
    width: proportional(1, { minWidth: 150 }),
    renderCell: (channel) =>
      channel.archivedAt ? (
        <StatusLabel variant="neutral" label="Archived" />
      ) : (
        <Text color="secondary">{channel.autoJoin ? 'Everyone is added' : 'Members choose'}</Text>
      ),
  },
  {
    key: 'members',
    header: 'Members',
    width: pixel(100),
    align: 'end',
    renderCell: (channel) => <Text hasTabularNumbers>{formatCount(channel.members)}</Text>,
  },
  {
    key: 'messages7d',
    header: 'Messages, 7 days',
    width: pixel(160),
    align: 'end',
    renderCell: (channel) => <Text hasTabularNumbers>{formatCount(channel.messages7d)}</Text>,
  },
  {
    key: 'lastMessageAt',
    header: 'Last message',
    width: pixel(150),
    renderCell: (channel) =>
      channel.lastMessageAt ? <Timestamp value={channel.lastMessageAt} format="relative" /> : <Text color="secondary">None in 30 days</Text>,
  },
]

function hiddenSummary(privateChannels: number, directMessages: number) {
  const parts: string[] = []
  if (privateChannels > 0) parts.push(plural(privateChannels, 'private channel'))
  if (directMessages > 0) parts.push(plural(directMessages, 'direct message conversation'))
  if (parts.length === 0) return 'Open channels. Private channels and direct messages are never listed here.'
  return `Open channels. There ${privateChannels + directMessages === 1 ? 'is' : 'are'} also ${parts.join(' and ')}; this console counts them and shows nothing else about them.`
}

export default function ChannelsPage() {
  const channels = useChannels()

  return (
    <Page title="Channels" summary={channels.data ? hiddenSummary(channels.data.privateChannels, channels.data.directMessages) : 'Open channels in this community.'}>
      <QueryState query={channels}>
        {(data) =>
          data.channels.length === 0 ? (
            <EmptyState
              title="No open channels yet"
              description="Channels are created in the Buzz app. Once a member creates an open channel it appears here."
            />
          ) : (
            <Table<ChannelRow> data={data.channels as ChannelRow[]} columns={COLUMNS} idKey="id" hasHover textOverflow="truncate" />
          )
        }
      </QueryState>
    </Page>
  )
}
