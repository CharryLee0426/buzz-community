import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/Layout'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { CopyField } from '../components/CopyField'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { StatusLabel } from '../components/StatusLabel'
import { formatDuration, shortKey } from '../lib/format'
import { useAudit, useMembers, useSettings } from '../lib/queries'
import { PROVIDER_LABEL, type StatusView } from '../lib/status'
import type { AuditEntry, Member, Settings } from '../lib/types'

interface Connection extends StatusView {
  id: string
  name: string
  purpose: string
  /** What to do about it; empty when there is nothing to do. */
  nextStep: string
}
type ConnectionRow = Connection & Record<string, unknown>
type AuditRow = AuditEntry & Record<string, unknown>

const OK = (label: string): StatusView => ({ variant: 'success', label })
const MISSING = (label: string): StatusView => ({ variant: 'error', label })
const OFF = (label: string): StatusView => ({ variant: 'neutral', label })

function agentHost({ hive }: Settings['integrations']): StatusView & { nextStep: string } {
  if (!hive.tokenConfigured) {
    return { ...MISSING('No token'), nextStep: 'Run the setup script; it generates HIVE_TOKEN for the admin and hive services.' }
  }
  if (!hive.online) {
    const never = hive.lastSeenAt === null
    return {
      ...(never ? OFF('Never connected') : MISSING('Offline')),
      nextStep: never ? 'Deploy the hive service.' : 'Check the hive service’s deployment and logs.',
    }
  }
  const providers = Object.entries(hive.providers)
    .filter(([, present]) => present)
    .map(([name]) => PROVIDER_LABEL[name] ?? name)
  return {
    ...OK('Online'),
    nextStep:
      providers.length > 0
        ? `Model keys present: ${providers.join(', ')}.`
        : 'No model key is set, so agents cannot start. Add ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY to the hive service.',
  }
}

function connections({ integrations }: Settings): Connection[] {
  return [
    {
      id: 'database',
      name: 'Community database',
      purpose: 'Members, channels and activity figures.',
      ...(integrations.database ? OK('Connected') : MISSING('Not connected')),
      nextStep: integrations.database ? '' : 'Set DATABASE_URL on the admin service and check that Postgres is running.',
    },
    {
      id: 'ownerKey',
      name: 'Owner key',
      purpose: 'Signs every member, invite and ban change sent to the relay.',
      ...(integrations.ownerKey ? OK('Set') : MISSING('Missing')),
      nextStep: integrations.ownerKey ? '' : 'Run the setup script; it generates CONSOLE_SECRET_KEY and tells the relay to trust it.',
    },
    {
      id: 'encryptionKey',
      name: 'Encryption key',
      purpose: 'Encrypts invite links and the keys of hosted agents before they are stored.',
      ...(integrations.encryptionKey ? OK('Set') : MISSING('Missing')),
      nextStep: integrations.encryptionKey ? '' : 'Run the setup script; it generates CONSOLE_ENCRYPTION_KEY.',
    },
    {
      id: 'railway',
      name: 'Railway API',
      purpose: 'Services, logs, metrics and deployments.',
      ...(integrations.railway ? OK('Connected') : MISSING('Not connected')),
      nextStep: integrations.railway
        ? ''
        : 'In Railway, open Project Settings, then Tokens, create a token for this environment, and set it as RAILWAY_API_TOKEN on the admin service.',
    },
    {
      id: 'webhook',
      name: 'Railway events',
      purpose: 'Crashes, failed deployments and usage alerts, shown under Alerts.',
      ...(integrations.webhook.configured ? OK('Ready to receive') : MISSING('No secret')),
      nextStep: integrations.webhook.configured
        ? 'Add the webhook address below to the Railway project, if it is not there yet.'
        : 'Run the setup script; it generates WEBHOOK_TOKEN.',
    },
    {
      id: 'alertForwarding',
      name: 'Alert forwarding',
      purpose: 'Repeats critical and warning alerts to a chat channel.',
      ...(integrations.alertForwarding ? OK('On') : OFF('Off')),
      nextStep: integrations.alertForwarding ? '' : 'Optional. Set ALERT_FORWARD_URL to a Slack, Discord or Feishu incoming webhook.',
    },
    { id: 'hive', name: 'Agent host', purpose: 'Runs the agents hosted for this community.', ...agentHost(integrations) },
  ]
}

const CONNECTION_COLUMNS: TableColumn<ConnectionRow>[] = [
  {
    key: 'name',
    header: 'Connection',
    width: proportional(3, { minWidth: 240 }),
    renderCell: (connection) => (
      <VStack gap={0}>
        <Text weight="medium">{connection.name}</Text>
        <Text type="supporting">{connection.purpose}</Text>
      </VStack>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: pixel(170),
    renderCell: (connection) => <StatusLabel variant={connection.variant} label={connection.label} />,
  },
  {
    key: 'nextStep',
    header: 'Next step',
    width: proportional(4, { minWidth: 280 }),
    renderCell: (connection) => (connection.nextStep ? <Text color="secondary">{connection.nextStep}</Text> : null),
  },
]

function Setup({ settings }: { settings: Settings }) {
  const { community, integrations, session } = settings
  return (
    <VStack gap={8}>
      <VStack gap={3}>
        <Heading level={2}>Connections</Heading>
        <Table<ConnectionRow>
          data={connections(settings) as ConnectionRow[]}
          columns={CONNECTION_COLUMNS}
          idKey="id"
          textOverflow="wrap"
          verticalAlign="top"
        />
      </VStack>

      <VStack gap={4} width="100%" maxWidth={720}>
        <Heading level={2}>Addresses and keys</Heading>
        <CopyField
          label="Community address"
          description="What Buzz connects to. People normally join through an invite link, which already contains it."
          value={community.address}
        />
        {community.consoleNpub ? (
          <CopyField
            label="This console’s public key"
            description="The relay treats this key as the community’s owner. Its secret half lives only in the admin service’s variables."
            value={community.consoleNpub}
          />
        ) : null}
        {integrations.webhook.url ? (
          <CopyField
            label="Webhook address for Railway"
            description="Paste it in Railway under Project Settings, Webhooks. The address is the secret: anyone who has it can post alerts here."
            value={integrations.webhook.url}
          />
        ) : null}
      </VStack>

      <VStack gap={1}>
        <Heading level={2}>Your session</Heading>
        <Text color="secondary">
          Signed in as {session.username}. A session lasts {formatDuration(session.lifetimeHours * 3600)} without activity. To change the
          password, run the setup script again.
        </Text>
      </VStack>
    </VStack>
  )
}

const ACTIONS: Record<string, string> = {
  'agent.authorized': 'Authorized an agent',
  'agent.created': 'Created an agent',
  'agent.deleted': 'Deleted an agent',
  'agent.updated': 'Edited an agent',
  'invite.created': 'Created an invite',
  'invite.revoked': 'Revoked an invite',
  'member.added': 'Added a member',
  'member.banned': 'Banned a member',
  'member.removed': 'Removed a member',
  'member.role_changed': 'Changed a role',
  'member.unbanned': 'Lifted a ban',
  'session.started': 'Signed in',
  'session.ended': 'Signed out',
  'session.failed': 'Failed to sign in',
}

const PUBLIC_KEY = /^[0-9a-f]{64}$/

/** The one or two facts that say what an entry was about, with a key shown the way the Members page shows it. */
function subjectOf(entry: AuditEntry, members: Map<string, Member>) {
  const parts: string[] = []
  const { name, role, note } = entry.detail as { name?: unknown; role?: unknown; note?: unknown }
  if (typeof name === 'string' && name) parts.push(name)
  if (typeof note === 'string' && note) parts.push(note)
  if (entry.target && PUBLIC_KEY.test(entry.target)) {
    const member = members.get(entry.target)
    // Someone who has since left is no longer on the roster; their key in hex is all that is known.
    parts.push(member ? (member.displayName ? `${member.displayName} (${shortKey(member.npub)})` : shortKey(member.npub)) : `key ${shortKey(entry.target, 8, 6)}`)
  } else if (entry.target) {
    parts.push(`${entry.target.slice(0, 8)}…`)
  }
  if (typeof role === 'string') parts.push(entry.action === 'member.role_changed' ? `now ${role}` : `as ${role}`)
  return parts.join(' · ')
}

function Activity() {
  const audit = useAudit()
  const roster = useMembers()
  const members = useMemo(() => new Map((roster.data?.members ?? []).map((member) => [member.pubkey, member])), [roster.data])

  const columns: TableColumn<AuditRow>[] = [
    {
      key: 'at',
      header: 'When',
      width: pixel(190),
      renderCell: (entry) => <Timestamp value={entry.at} format="date_time" />,
    },
    {
      key: 'actor',
      header: 'Who',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (entry) => <Text>{entry.actor}</Text>,
    },
    {
      key: 'action',
      header: 'What',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (entry) =>
        entry.action === 'session.failed' ? (
          <StatusLabel variant="warning" label={ACTIONS[entry.action]!} />
        ) : (
          <Text>{ACTIONS[entry.action] ?? entry.action}</Text>
        ),
    },
    {
      key: 'subject',
      header: 'Subject',
      width: proportional(3, { minWidth: 200 }),
      renderCell: (entry) => <Text color="secondary">{subjectOf(entry, members) || '—'}</Text>,
    },
    {
      key: 'clientIp',
      header: 'From',
      width: pixel(160),
      renderCell: (entry) => (
        <Text type="code" size="sm" color="secondary">
          {entry.clientIp ?? '—'}
        </Text>
      ),
    },
  ]

  return (
    <QueryState query={audit} skeletonRows={10}>
      {(data) =>
        data.entries.length === 0 ? (
          <EmptyState title="Nothing recorded yet" description="Sign-ins and every change made from this console are listed here." />
        ) : (
          <Table<AuditRow> data={data.entries as AuditRow[]} columns={columns} idKey="id" density="compact" hasHover textOverflow="truncate" />
        )
      }
    </QueryState>
  )
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'activity' ? 'activity' : 'setup'
  const settings = useSettings()

  return (
    <Page
      title="Settings"
      summary={settings.data ? `What this console is connected to, for ${settings.data.community.host}.` : 'What this console is connected to.'}
      toolbar={
        <TabList value={view} onChange={(value) => setParams(value === 'activity' ? { view: 'activity' } : {}, { replace: true })}>
          <Tab value="setup" label="Setup" />
          <Tab value="activity" label="Activity log" />
        </TabList>
      }>
      {view === 'setup' ? <QueryState query={settings}>{(data) => <Setup settings={data} />}</QueryState> : <Activity />}
    </Page>
  )
}
