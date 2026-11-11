import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { MoreMenu } from '@astryxdesign/core/MoreMenu'
import { MultiSelector } from '@astryxdesign/core/MultiSelector'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { Selector } from '@astryxdesign/core/Selector'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { useToast } from '@astryxdesign/core/Toast'
import { CopyField } from '../components/CopyField'
import { FormDialog } from '../components/FormDialog'
import { Identity } from '../components/Identity'
import { Page } from '../components/Page'
import { QueryState } from '../components/QueryState'
import { StatusLabel } from '../components/StatusLabel'
import { errorMessage } from '../lib/errors'
import { formatCount, plural, shortKey } from '../lib/format'
import { useCopy } from '../lib/hooks'
import {
  useAgents,
  useAuthorizeAgent,
  useCreateAgent,
  useDeleteAgent,
  useMembers,
  useUpdateAgent,
  type NewAgentInput,
} from '../lib/queries'
import { PROVIDER_LABEL, type StatusView } from '../lib/status'
import type { AgentProvider, AgentsResponse, AgentState, HostedAgent, Member } from '../lib/types'

type HostedRow = HostedAgent & Record<string, unknown>
type ElsewhereAgent = AgentsResponse['elsewhere'][number]
type ElsewhereRow = ElsewhereAgent & Record<string, unknown>
type Audience = HostedAgent['access']

const STATE: Record<AgentState, StatusView> = {
  awaiting_authorization: { variant: 'warning', label: 'Waiting for its owner' },
  stopped: { variant: 'neutral', label: 'Stopped' },
  host_offline: { variant: 'error', label: 'Host offline' },
  starting: { variant: 'accent', label: 'Starting', active: true },
  running: { variant: 'success', label: 'Running' },
  backoff: { variant: 'warning', label: 'Restarting after a crash', active: true },
  failed: { variant: 'error', label: 'Failed to start' },
  stopping: { variant: 'neutral', label: 'Stopping', active: true },
}

/** The variable that supplies each provider's key on the hive service. */
const PROVIDER_VARIABLE: Record<AgentProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}
const PROVIDER_OPTIONS = (Object.keys(PROVIDER_VARIABLE) as AgentProvider[]).map((value) => ({ value, label: PROVIDER_LABEL[value]! }))
const OTHER_MODEL = 'other'

interface Draft {
  name: string
  about: string
  provider: AgentProvider
  model: string
  instructions: string
}

/** The people an agent can be given to, and whether that list is known yet. */
interface Roster {
  people: Member[]
  state: 'loading' | 'failed' | 'ready'
}

const personLabel = (member: Pick<Member, 'displayName' | 'npub'>) => member.displayName || shortKey(member.npub)

/** Why a member picker cannot be used right now, if it cannot. */
function rosterBlock(roster: Roster): string | undefined {
  if (roster.state === 'failed') return 'Members could not be loaded. Close this and try again.'
  if (roster.state === 'ready' && roster.people.length === 0) return 'Nobody has joined this community yet. Invite people under Members first.'
  return undefined
}

function audienceText(agent: HostedAgent) {
  if (agent.access === 'owner') return agent.owner ? `Only ${agent.owner.name ?? shortKey(agent.owner.npub)}` : 'Only its owner'
  if (agent.access === 'anyone') return 'Every member'
  return `${plural(agent.allowlist.length, 'chosen member')}`
}

/** The fields every hosted agent has, whoever it answers. */
function AgentFields({ draft, onChange, data }: { draft: Draft; onChange: (patch: Partial<Draft>) => void; data: AgentsResponse }) {
  const suggestions = data.models[draft.provider] ?? []
  const isSuggested = suggestions.some((model) => model.id === draft.model)
  // Any model id works; the list is only the common ones. Start on the free-text field when the agent already uses another.
  const [isOther, setIsOther] = useState(draft.model !== '' && !isSuggested)
  // The host reports which provider keys it holds; before it has ever connected there is nothing to warn about.
  const keyMissing = data.host.lastSeenAt !== null && data.host.providers[draft.provider] === false
  const hasList = suggestions.length > 0

  return (
    <>
      <TextInput
        label="Name"
        description="How it appears to members. They mention it by this name."
        value={draft.name}
        onChange={(name) => onChange({ name: name.slice(0, 64) })}
      />
      <TextInput
        label="What it is for"
        placeholder="Answers questions about our release process"
        value={draft.about}
        onChange={(about) => onChange({ about: about.slice(0, 280) })}
        isOptional
      />
      <HStack gap={3} vAlign="start">
        <Selector
          label="Model provider"
          options={PROVIDER_OPTIONS}
          value={draft.provider}
          onChange={(value) => {
            const next = value as AgentProvider
            setIsOther(false)
            onChange({ provider: next, model: data.models[next]?.[0]?.id ?? '' })
          }}
          status={
            keyMissing
              ? { type: 'warning', message: `The agent host has no ${PROVIDER_VARIABLE[draft.provider]}. Set it on the hive service.` }
              : undefined
          }
          width="100%"
        />
        {hasList ? (
          <Selector
            label="Model"
            options={[...suggestions.map((model) => ({ value: model.id, label: model.label })), { value: OTHER_MODEL, label: 'Another model…' }]}
            value={isOther ? OTHER_MODEL : draft.model}
            onChange={(value) => {
              setIsOther(value === OTHER_MODEL)
              onChange({ model: value === OTHER_MODEL ? '' : value })
            }}
            width="100%"
          />
        ) : null}
      </HStack>
      {isOther || !hasList ? (
        <TextInput
          label="Model id"
          description="Exactly as the provider names it."
          value={draft.model}
          onChange={(model) => onChange({ model: model.trim() })}
          hasSpellCheck={false}
          hasAutoCorrect={false}
          autoCapitalize="none"
        />
      ) : null}
      <TextArea
        label="Instructions"
        description="Standing guidance the agent follows in every conversation."
        value={draft.instructions}
        onChange={(instructions) => onChange({ instructions })}
        rows={4}
        isOptional
      />
    </>
  )
}

function MembersPicker({ roster, value, onChange, extra = [] }: { roster: Roster; value: string[]; onChange: (value: string[]) => void; extra?: { value: string; label: string }[] }) {
  const options = [...roster.people.map((member) => ({ value: member.pubkey, label: personLabel(member) })), ...extra]
  const blocked = rosterBlock(roster)
  return (
    <MultiSelector
      label="Members who can use it"
      placeholder="Choose members"
      options={options}
      value={value}
      onChange={(next) => onChange(next)}
      triggerDisplay="labels"
      hasSearch={options.length > 8}
      isLoading={roster.state === 'loading'}
      isDisabled={blocked !== undefined}
      disabledMessage={blocked}
    />
  )
}

function AuthorizeDialog({ agent, title, onClose }: { agent: HostedAgent; title: string; onClose: () => void }) {
  const authorize = useAuthorizeAgent()
  const showToast = useToast()
  const [tag, setTag] = useState('')
  const owner = agent.owner?.name ?? 'the owner'

  return (
    <FormDialog
      isOpen
      onClose={onClose}
      title={title}
      subtitle={`${agent.name} answers only ${owner}, so ${owner} has to vouch for it before it can connect.`}
      submitLabel="Start agent"
      cancelLabel="Later"
      isSubmitting={authorize.isPending}
      isSubmitDisabled={tag.trim() === ''}
      error={authorize.error}
      width={560}
      onSubmit={() =>
        authorize.mutate(
          { id: agent.id, tag: tag.trim() },
          {
            onSuccess: () => {
              showToast({ body: `${agent.name} is authorized and starting` })
              onClose()
            },
          },
        )
      }>
      <CopyField
        label="1. Send this key to the owner"
        description="The agent’s public key. It is safe to share."
        value={agent.npub}
        copyLabel="Copy key"
      />
      <Text type="supporting">
        2. In Buzz, they open Settings, then Security, then Authorize external identity, and paste the key. Buzz gives them an
        authorization to send back to you.
      </Text>
      <TextArea
        label="3. Paste their authorization"
        placeholder={'["auth", "…", "", "…"]'}
        value={tag}
        onChange={setTag}
        rows={3}
        hasSpellCheck={false}
      />
    </FormDialog>
  )
}

function NewAgentDialog({ data, roster, onClose }: { data: AgentsResponse; roster: Roster; onClose: () => void }) {
  const createAgent = useCreateAgent()
  const showToast = useToast()
  const [audience, setAudience] = useState<Audience>('owner')
  const [owner, setOwner] = useState('')
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [draft, setDraft] = useState<Draft>({
    name: '',
    about: '',
    provider: 'anthropic',
    model: data.models.anthropic?.[0]?.id ?? '',
    instructions: '',
  })
  const [created, setCreated] = useState<HostedAgent | null>(null)

  if (created) {
    return <AuthorizeDialog agent={created} title="Ask the owner to authorize it" onClose={onClose} />
  }

  const memberOptions = roster.people.map((member) => ({ value: member.pubkey, label: personLabel(member) }))
  const blocked = rosterBlock(roster)
  const incomplete =
    draft.name.trim() === '' ||
    draft.model === '' ||
    (audience === 'owner' && owner === '') ||
    (audience === 'allowlist' && allowlist.length === 0)

  const submit = () => {
    const common = { ...draft, name: draft.name.trim(), about: draft.about.trim() }
    const input: NewAgentInput =
      audience === 'owner'
        ? { kind: 'personal', owner, ...common }
        : { kind: 'shared', access: audience, allowlist: audience === 'allowlist' ? allowlist : [], ...common }
    createAgent.mutate(input, {
      onSuccess: (agent) => {
        if (agent.kind === 'personal') {
          setCreated(agent)
        } else {
          showToast({ body: `${agent.name} is starting` })
          onClose()
        }
      },
    })
  }

  return (
    <FormDialog
      isOpen
      onClose={onClose}
      title="Host an agent"
      subtitle="It runs on this community’s infrastructure, so it keeps answering when nobody’s laptop is open."
      submitLabel={audience === 'owner' ? 'Create agent' : 'Create and start'}
      isSubmitting={createAgent.isPending}
      isSubmitDisabled={incomplete}
      error={createAgent.error}
      width={560}
      onSubmit={submit}>
      <RadioList label="Who can use it" value={audience} onChange={(value) => setAudience(value as Audience)}>
        <RadioListItem
          value="owner"
          label="One member"
          description="A personal agent. Its owner authorizes it from their Buzz app, and it answers nobody else."
        />
        <RadioListItem value="allowlist" label="Chosen members" description="A shared agent with its own identity, held by this console." />
        <RadioListItem value="anyone" label="Every member" description="A shared agent anyone in the community can talk to." />
      </RadioList>
      {audience === 'owner' ? (
        <Selector
          label="Owner"
          placeholder="Choose a member"
          options={memberOptions}
          value={owner}
          onChange={setOwner}
          hasSearch={memberOptions.length > 8}
          isLoading={roster.state === 'loading'}
          isDisabled={blocked !== undefined}
          disabledMessage={blocked}
        />
      ) : null}
      {audience === 'allowlist' ? <MembersPicker roster={roster} value={allowlist} onChange={setAllowlist} /> : null}
      <AgentFields draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} data={data} />
    </FormDialog>
  )
}

function EditAgentDialog({ agent, data, roster, onClose }: { agent: HostedAgent; data: AgentsResponse; roster: Roster; onClose: () => void }) {
  const updateAgent = useUpdateAgent()
  const showToast = useToast()
  const [draft, setDraft] = useState<Draft>({
    name: agent.name,
    about: agent.about,
    provider: agent.provider,
    model: agent.model,
    instructions: agent.instructions,
  })
  const [access, setAccess] = useState<Audience>(agent.access)
  const [allowlist, setAllowlist] = useState<string[]>(agent.allowlist.map((person) => person.pubkey))
  const isShared = agent.kind === 'shared'

  // Someone on the allowlist may have left the community since. They stay selectable so the list reads true,
  // and are marked as gone only once the roster is known.
  const departed = useMemo(() => {
    const current = new Set(roster.people.map((member) => member.pubkey))
    return agent.allowlist
      .filter((person) => !current.has(person.pubkey))
      .map((person) => {
        const name = person.name ?? shortKey(person.npub)
        return { value: person.pubkey, label: roster.state === 'ready' ? `${name} (no longer a member)` : name }
      })
  }, [roster, agent.allowlist])

  return (
    <FormDialog
      isOpen
      onClose={onClose}
      title={`Edit ${agent.name}`}
      subtitle="The agent restarts with the changes, usually within a minute."
      submitLabel="Save changes"
      isSubmitting={updateAgent.isPending}
      isSubmitDisabled={draft.name.trim() === '' || draft.model === '' || (isShared && access === 'allowlist' && allowlist.length === 0)}
      error={updateAgent.error}
      width={560}
      onSubmit={() =>
        updateAgent.mutate(
          {
            id: agent.id,
            changes: {
              ...draft,
              name: draft.name.trim(),
              about: draft.about.trim(),
              ...(isShared ? { access, allowlist: access === 'allowlist' ? allowlist : [] } : {}),
            },
          },
          {
            onSuccess: () => {
              showToast({ body: 'Agent updated' })
              onClose()
            },
          },
        )
      }>
      {isShared ? (
        <>
          <RadioList label="Who can use it" orientation="horizontal" value={access} onChange={(value) => setAccess(value as Audience)}>
            <RadioListItem value="allowlist" label="Chosen members" />
            <RadioListItem value="anyone" label="Every member" />
          </RadioList>
          {access === 'allowlist' ? <MembersPicker roster={roster} value={allowlist} onChange={setAllowlist} extra={departed} /> : null}
        </>
      ) : null}
      <AgentFields draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} data={data} />
    </FormDialog>
  )
}

function HostedTable({ data, roster, onCreate }: { data: AgentsResponse; roster: Roster; onCreate: () => void }) {
  const showToast = useToast()
  const copy = useCopy()
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const [editing, setEditing] = useState<HostedAgent | null>(null)
  const [authorizing, setAuthorizing] = useState<HostedAgent | null>(null)
  // The agent outlives `isDeleting`, so the dialog still names it while it closes.
  const [deleting, setDeleting] = useState<HostedAgent | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  if (data.hosted.length === 0) {
    return (
      <EmptyState
        title="No agents are hosted here yet"
        description="Host one when it should stay online for its owner, or when more than one member needs to use it."
        actions={<Button label="Host an agent" variant="primary" onClick={onCreate} />}
      />
    )
  }

  const modelLabel = (agent: HostedAgent) => data.models[agent.provider]?.find((model) => model.id === agent.model)?.label ?? agent.model
  const setRunning = (agent: HostedAgent, running: boolean) =>
    updateAgent.mutate(
      { id: agent.id, changes: { desiredState: running ? 'running' : 'stopped' } },
      {
        onSuccess: () => showToast({ body: running ? `${agent.name} is starting` : `${agent.name} is stopping` }),
        onError: (error) => showToast({ body: errorMessage(error), type: 'error' }),
      },
    )

  const columns: TableColumn<HostedRow>[] = [
    {
      key: 'agent',
      header: 'Agent',
      width: proportional(3, { minWidth: 220 }),
      renderCell: (agent) => <Identity name={agent.name} npub={agent.npub} />,
    },
    {
      key: 'answers',
      header: 'Answers',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (agent) => <Text>{audienceText(agent)}</Text>,
    },
    {
      key: 'model',
      header: 'Model',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (agent) => <Text color="secondary">{modelLabel(agent)}</Text>,
    },
    {
      key: 'state',
      header: 'Status',
      width: proportional(3, { minWidth: 220 }),
      renderCell: (agent) => {
        const state = STATE[agent.state] ?? { variant: 'neutral' as const, label: agent.state }
        // The reason sits in the row: a failed agent is the row an operator came to read.
        const reason = agent.state === 'running' || agent.state === 'stopped' ? undefined : agent.status?.lastError
        return (
          <VStack gap={0}>
            <StatusLabel variant={state.variant} label={state.label} isPulsing={state.active} />
            {reason ? (
              <Text type="supporting" maxLines={2}>
                {reason}
              </Text>
            ) : null}
          </VStack>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      width: pixel(72),
      align: 'end',
      renderCell: (agent) => (
        <MoreMenu
          size="sm"
          label={`Actions for ${agent.name}`}
          alignment="end"
          items={[
            ...(agent.state === 'awaiting_authorization'
              ? [{ label: 'Add owner’s authorization…', onClick: () => setAuthorizing(agent) }]
              : [
                  agent.desiredState === 'running'
                    ? { label: 'Stop', onClick: () => setRunning(agent, false) }
                    : { label: 'Start', onClick: () => setRunning(agent, true) },
                ]),
            { label: 'Edit…', onClick: () => setEditing(agent) },
            { label: 'Copy public key', onClick: () => void copy(agent.npub, 'Public key') },
            { type: 'divider' as const },
            {
              label: 'Delete…',
              variant: 'destructive' as const,
              onClick: () => {
                setDeleting(agent)
                setIsDeleting(true)
              },
            },
          ]}
        />
      ),
    },
  ]

  return (
    <>
      <Table<HostedRow> data={data.hosted as HostedRow[]} columns={columns} idKey="id" hasHover textOverflow="truncate" />
      {editing ? <EditAgentDialog agent={editing} data={data} roster={roster} onClose={() => setEditing(null)} /> : null}
      {authorizing ? <AuthorizeDialog agent={authorizing} title={`Authorize ${authorizing.name}`} onClose={() => setAuthorizing(null)} /> : null}
      <AlertDialog
        isOpen={isDeleting}
        onOpenChange={(open) => !open && setIsDeleting(false)}
        title={deleting ? `Delete ${deleting.name}?` : ''}
        description="It stops, leaves the community, and its key is destroyed, so this identity can never come back. Messages it already sent stay."
        actionLabel="Delete agent"
        isActionLoading={deleteAgent.isPending}
        onAction={() =>
          deleting &&
          deleteAgent.mutate(
            { id: deleting.id },
            {
              onSuccess: (result) =>
                showToast(
                  result.membershipRemoved
                    ? { body: 'Agent deleted' }
                    : { body: 'Agent deleted, but the relay kept its membership. Remove it under Members.', type: 'error' },
                ),
              onError: (error) => showToast({ body: errorMessage(error), type: 'error' }),
              onSettled: () => setIsDeleting(false),
            },
          )
        }
      />
    </>
  )
}

const ELSEWHERE_COLUMNS: TableColumn<ElsewhereRow>[] = [
  {
    key: 'agent',
    header: 'Agent',
    width: proportional(3, { minWidth: 220 }),
    renderCell: (agent) => <Identity name={agent.name} npub={agent.npub} />,
  },
  {
    key: 'owner',
    header: 'Owner',
    width: proportional(2, { minWidth: 160 }),
    renderCell: (agent) => <Text>{agent.owner.name ?? shortKey(agent.owner.npub)}</Text>,
  },
  {
    key: 'firstSeenAt',
    header: 'First seen',
    width: pixel(140),
    renderCell: (agent) => <Timestamp value={agent.firstSeenAt} format="date" />,
  },
  {
    key: 'lastMessageAt',
    header: 'Last message',
    width: pixel(150),
    renderCell: (agent) =>
      agent.lastMessageAt ? <Timestamp value={agent.lastMessageAt} format="relative" /> : <Text color="secondary">None in 30 days</Text>,
  },
]

function hostProblem(data: AgentsResponse): { title: string; description: string } | null {
  if (data.host.online || data.hosted.length === 0) return null
  if (data.host.lastSeenAt === null) {
    return {
      title: 'The agent host has not connected',
      description: 'Hosted agents start once the hive service is deployed and can reach this console. Until then they stay offline.',
    }
  }
  return {
    title: 'The agent host is offline',
    description: 'Hosted agents are not running. Check the hive service’s deployment and logs.',
  }
}

export default function AgentsPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'elsewhere' ? 'elsewhere' : 'hosted'
  const agents = useAgents()
  const members = useMembers()
  const [isCreating, setIsCreating] = useState(false)

  const roster = useMemo<Roster>(
    () => ({
      people: (members.data?.members ?? []).filter((member) => member.kind === 'person' && !member.banned),
      state: members.data ? 'ready' : members.isError ? 'failed' : 'loading',
    }),
    [members.data, members.isError],
  )
  const data = agents.data
  const problem = data ? hostProblem(data) : null

  return (
    <Page
      title="Agents"
      summary="An agent one member uses can run in their own Buzz app or here. An agent several members use always runs here."
      actions={<Button label="Host an agent" variant="primary" isDisabled={!data} onClick={() => setIsCreating(true)} />}
      toolbar={
        <TabList value={view} onChange={(value) => setParams(value === 'elsewhere' ? { view: 'elsewhere' } : {}, { replace: true })}>
          <Tab value="hosted" label={data ? `Hosted here (${formatCount(data.hosted.length)})` : 'Hosted here'} />
          <Tab value="elsewhere" label={data ? `In members’ apps (${formatCount(data.elsewhere.length)})` : 'In members’ apps'} />
        </TabList>
      }>
      <QueryState query={agents}>
        {(loaded) => (
          <VStack gap={4}>
            {problem && view === 'hosted' ? <Banner status="warning" title={problem.title} description={problem.description} /> : null}
            {view === 'hosted' ? (
              <HostedTable data={loaded} roster={roster} onCreate={() => setIsCreating(true)} />
            ) : loaded.elsewhere.length === 0 ? (
              <EmptyState
                title="No member runs an agent of their own"
                description="Agents that members start in their Buzz app appear here once they connect. They answer only their owner."
              />
            ) : (
              <Table<ElsewhereRow> data={loaded.elsewhere as ElsewhereRow[]} columns={ELSEWHERE_COLUMNS} idKey="pubkey" hasHover textOverflow="truncate" />
            )}
          </VStack>
        )}
      </QueryState>
      {isCreating && data ? <NewAgentDialog data={data} roster={roster} onClose={() => setIsCreating(false)} /> : null}
    </Page>
  )
}
