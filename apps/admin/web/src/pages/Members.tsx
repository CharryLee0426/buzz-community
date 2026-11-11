import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { MoreMenu } from '@astryxdesign/core/MoreMenu'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { Selector } from '@astryxdesign/core/Selector'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { useToast } from '@astryxdesign/core/Toast'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
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
  useAddMember,
  useBanMember,
  useCreateInvite,
  useInvites,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
  useSetRole,
  useUnbanMember,
} from '../lib/queries'
import type { Invite, Member } from '../lib/types'

type MemberRow = Member & Record<string, unknown>
type InviteRow = Invite & Record<string, unknown>

const ROLE_LABEL: Record<Member['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
const KIND_LABEL: Record<Member['kind'], string> = { person: 'Person', agent: 'Agent', console: 'This console' }

const EXPIRY_OPTIONS = [
  { value: '1', label: '1 hour' },
  { value: '24', label: '1 day' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
]
const USES_OPTIONS = [
  { value: '1', label: 'One person' },
  { value: '5', label: '5 people' },
  { value: '25', label: '25 people' },
  { value: 'unlimited', label: 'No limit' },
]

/** A name is optional and anyone can pick one, so a member without one is named by their key. */
const nameOf = (member: Member) => member.displayName || shortKey(member.npub)

function InviteDialog({ onClose }: { onClose: () => void }) {
  const createInvite = useCreateInvite()
  const [ttlHours, setTtlHours] = useState('72')
  const [uses, setUses] = useState('1')
  const [note, setNote] = useState('')
  const created = createInvite.data

  if (created) {
    return (
      <FormDialog isOpen onClose={onClose} title="Invite link ready" subtitle="Anyone who opens this link can join, until it expires or runs out.">
        <CopyField label="Invite link" value={created.url} copyLabel="Copy link" />
        <Text type="supporting">
          {created.saved
            ? 'Send the whole link. It is also listed under Invites, where you can copy it again or revoke it.'
            : 'Send the whole link, and copy it now: this console has no encryption key, so it cannot show the link again. You can still revoke it under Invites.'}
        </Text>
      </FormDialog>
    )
  }

  return (
    <FormDialog
      isOpen
      onClose={onClose}
      title="Invite people"
      subtitle="Creates a link that admits whoever opens it as a member."
      submitLabel="Create link"
      isSubmitting={createInvite.isPending}
      error={createInvite.error}
      onSubmit={() =>
        createInvite.mutate({ ttlHours: Number(ttlHours), maxUses: uses === 'unlimited' ? null : Number(uses), note: note.trim() })
      }>
      <HStack gap={3}>
        <Selector label="Expires after" options={EXPIRY_OPTIONS} value={ttlHours} onChange={setTtlHours} width="100%" />
        <Selector label="Can be used by" options={USES_OPTIONS} value={uses} onChange={setUses} width="100%" />
      </HStack>
      <TextInput
        label="Note"
        description="Only you see this. It helps you tell links apart later."
        placeholder="Design team, November"
        value={note}
        onChange={setNote}
        isOptional
      />
    </FormDialog>
  )
}

function AddMemberDialog({ onClose }: { onClose: () => void }) {
  const addMember = useAddMember()
  const showToast = useToast()
  const [pubkey, setPubkey] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')

  return (
    <FormDialog
      isOpen
      onClose={onClose}
      title="Add a member by key"
      subtitle="For someone whose public key you already have. They can connect right away, with no invite."
      submitLabel="Add member"
      isSubmitting={addMember.isPending}
      isSubmitDisabled={pubkey.trim() === ''}
      error={addMember.error}
      onSubmit={() =>
        addMember.mutate(
          { pubkey: pubkey.trim(), role },
          {
            onSuccess: () => {
              showToast({ body: 'Member added' })
              onClose()
            },
          },
        )
      }>
      <TextInput
        label="Public key"
        description="An npub, or 64 hex characters. In Buzz it is under Settings, Identity."
        placeholder="npub1…"
        value={pubkey}
        onChange={setPubkey}
        hasAutoFocus
        hasSpellCheck={false}
        hasAutoCorrect={false}
        autoCapitalize="none"
      />
      <RadioList label="Role" value={role} onChange={(value) => setRole(value as 'member' | 'admin')}>
        <RadioListItem value="member" label="Member" description="Reads and posts in the channels they are in." />
        <RadioListItem value="admin" label="Admin" description="Can also invite, remove and ban members from inside Buzz." />
      </RadioList>
    </FormDialog>
  )
}

type Action = 'remove' | 'ban'

const CONFIRMATION: Record<Action, { title: (name: string) => string; description: string; actionLabel: string; done: string }> = {
  remove: {
    title: (name) => `Remove ${name}?`,
    description: 'They are disconnected at once and can no longer read or post. Their past messages stay. They can rejoin with a new invite.',
    actionLabel: 'Remove',
    done: 'Member removed',
  },
  ban: {
    title: (name) => `Ban ${name}?`,
    description:
      'They are disconnected and refused on every reconnect, including with a new invite, until the ban is lifted. Agents they own are refused too.',
    actionLabel: 'Ban',
    done: 'Member banned',
  },
}

function MembersTable({ members, onInvite }: { members: Member[]; onInvite: () => void }) {
  const showToast = useToast()
  const copy = useCopy()
  const setRole = useSetRole()
  const removeMember = useRemoveMember()
  const banMember = useBanMember()
  const unbanMember = useUnbanMember()
  const [query, setQuery] = useState('')
  // The subject outlives `isConfirming`, so a dialog still names the member while it closes.
  const [pending, setPending] = useState<{ action: Action; member: Member } | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return members
    return members.filter(
      (member) =>
        member.displayName?.toLowerCase().includes(term) ||
        member.npub.includes(term) ||
        member.pubkey.includes(term) ||
        member.nip05?.toLowerCase().includes(term),
    )
  }, [members, query])

  // The console's own key is always on the roster; a community with nobody else has no members yet.
  if (members.every((member) => member.kind === 'console')) {
    return (
      <EmptyState
        title="No members yet"
        description="People join through an invite link, or when you add their public key."
        actions={<Button label="Invite people" variant="primary" onClick={onInvite} />}
      />
    )
  }

  const fail = (error: unknown) => showToast({ body: errorMessage(error), type: 'error' })
  const ask = (action: Action, member: Member) => {
    setPending({ action, member })
    setIsConfirming(true)
  }
  const settle = (body: string) => ({
    onSuccess: () => showToast({ body }),
    onError: fail,
    onSettled: () => setIsConfirming(false),
  })

  const columns: TableColumn<MemberRow>[] = [
    {
      key: 'member',
      header: 'Member',
      width: proportional(3, { minWidth: 220 }),
      renderCell: (member) => (
        <Identity name={member.displayName} npub={member.npub} fallback={member.kind === 'console' ? 'Console owner key' : undefined} />
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (member) =>
        member.banned ? <StatusLabel variant="error" label="Banned" /> : <Text>{ROLE_LABEL[member.role]}</Text>,
    },
    {
      key: 'kind',
      header: 'Type',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (member) => <Text color="secondary">{KIND_LABEL[member.kind]}</Text>,
    },
    {
      key: 'joined',
      header: 'Joined',
      width: pixel(130),
      renderCell: (member) => <Timestamp value={member.joinedAt} format="date" />,
    },
    {
      key: 'lastMessage',
      header: 'Last message',
      width: pixel(140),
      renderCell: (member) =>
        member.lastMessageAt ? <Timestamp value={member.lastMessageAt} format="relative" /> : <Text color="secondary">None in 30 days</Text>,
    },
    {
      key: 'actions',
      header: '',
      width: pixel(72),
      align: 'end',
      renderCell: (member) => {
        const copyKey = { label: 'Copy public key', onClick: () => void copy(member.npub, 'Public key') }
        // The owner key signs every change made here; nothing about it can be changed from the console.
        if (member.role === 'owner') return <MoreMenu size="sm" label={`Actions for ${nameOf(member)}`} alignment="end" items={[copyKey]} />
        const promote = member.role === 'member'
        return (
          <MoreMenu
            size="sm"
            label={`Actions for ${nameOf(member)}`}
            alignment="end"
            items={[
              copyKey,
              ...(member.kind === 'person'
                ? [
                    {
                      label: promote ? 'Make admin' : 'Make member',
                      onClick: () =>
                        setRole.mutate(
                          { pubkey: member.pubkey, role: promote ? 'admin' : 'member' },
                          { onSuccess: () => showToast({ body: `${nameOf(member)} is now ${promote ? 'an admin' : 'a member'}` }), onError: fail },
                        ),
                    },
                  ]
                : []),
              member.banned
                ? {
                    // Undoing a ban harms nobody and can be redone, so it asks for no confirmation.
                    label: 'Lift ban',
                    onClick: () =>
                      unbanMember.mutate(
                        { pubkey: member.pubkey },
                        { onSuccess: () => showToast({ body: `${nameOf(member)} can connect again` }), onError: fail },
                      ),
                  }
                : { label: 'Ban…', onClick: () => ask('ban', member) },
              { type: 'divider' as const },
              { label: 'Remove…', variant: 'destructive' as const, onClick: () => ask('remove', member) },
            ]}
          />
        )
      },
    },
  ]

  const confirmation = pending ? CONFIRMATION[pending.action] : null

  return (
    <VStack gap={4}>
      <VStack width="100%" maxWidth={320}>
        <TextInput
          label="Search members"
          isLabelHidden
          placeholder="Search by name or key"
          value={query}
          onChange={setQuery}
          startIcon={MagnifyingGlassIcon}
          hasClear
          width="100%"
        />
      </VStack>
      {visible.length === 0 ? (
        <EmptyState
          title="No member matches that search"
          description="Search looks at names, NIP-05 addresses and public keys."
          actions={<Button label="Clear search" variant="secondary" onClick={() => setQuery('')} />}
        />
      ) : (
        <Table<MemberRow> data={visible as MemberRow[]} columns={columns} idKey="pubkey" hasHover textOverflow="truncate" />
      )}

      <AlertDialog
        isOpen={isConfirming}
        onOpenChange={(open) => !open && setIsConfirming(false)}
        title={pending && confirmation ? confirmation.title(nameOf(pending.member)) : ''}
        description={confirmation?.description ?? ''}
        actionLabel={confirmation?.actionLabel ?? ''}
        isActionLoading={removeMember.isPending || banMember.isPending}
        onAction={() => {
          if (!pending || !confirmation) return
          const mutation = pending.action === 'remove' ? removeMember : banMember
          mutation.mutate({ pubkey: pending.member.pubkey }, settle(confirmation.done))
        }}
      />
    </VStack>
  )
}

const INVITE_STATE: Record<Invite['state'], { variant: 'success' | 'neutral' | 'warning'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  used: { variant: 'neutral', label: 'Used up' },
  expired: { variant: 'neutral', label: 'Expired' },
  revoked: { variant: 'warning', label: 'Revoked' },
}

const inviteName = (invite: Invite) => invite.note || `invite ${invite.id.slice(0, 8)}`

function InvitesTable({ invites, onCreate }: { invites: Invite[]; onCreate: () => void }) {
  const showToast = useToast()
  const copy = useCopy()
  const revokeInvite = useRevokeInvite()
  const [revoking, setRevoking] = useState<Invite | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  /** A link the browser would not copy, shown so it can be copied by hand. */
  const [shown, setShown] = useState<Invite | null>(null)

  if (invites.length === 0) {
    return (
      <EmptyState
        title="No invites in the last 90 days"
        description="People join this community through an invite link, or when someone adds their key directly."
        actions={<Button label="Invite people" variant="primary" onClick={onCreate} />}
      />
    )
  }

  const columns: TableColumn<InviteRow>[] = [
    {
      key: 'note',
      header: 'Invite',
      width: proportional(3, { minWidth: 200 }),
      renderCell: (invite) => (
        <VStack gap={0}>
          <Text weight={invite.note ? 'medium' : 'normal'} color={invite.note ? 'primary' : 'secondary'} maxLines={1}>
            {invite.note || 'No note'}
          </Text>
          <Text type="supporting" maxLines={1}>
            {invite.viaConsole ? `Created here by ${invite.createdByName ?? 'an operator'}` : `Created by ${invite.createdByName ?? 'a member'}`}
          </Text>
        </VStack>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (invite) => <StatusLabel variant={INVITE_STATE[invite.state].variant} label={INVITE_STATE[invite.state].label} />,
    },
    {
      key: 'uses',
      header: 'Used',
      width: pixel(110),
      renderCell: (invite) => (
        <Text hasTabularNumbers>
          {formatCount(invite.useCount)}
          {invite.maxUses === null ? '' : ` of ${formatCount(invite.maxUses)}`}
        </Text>
      ),
    },
    {
      key: 'expires',
      header: 'Expires',
      width: pixel(150),
      renderCell: (invite) =>
        invite.state === 'active' ? <Timestamp value={invite.expiresAt} format="relative" /> : <Timestamp value={invite.expiresAt} format="date" />,
    },
    {
      key: 'actions',
      header: '',
      width: pixel(72),
      align: 'end',
      renderCell: (invite) => {
        if (invite.state !== 'active') return null
        const url = invite.url
        return (
          <MoreMenu
            size="sm"
            label={`Actions for ${inviteName(invite)}`}
            alignment="end"
            items={[
              ...(url
                ? [
                    {
                      label: 'Copy link',
                      onClick: () => void copy(url, 'Invite link').then((copied) => !copied && setShown(invite)),
                    },
                  ]
                : []),
              {
                label: 'Revoke…',
                variant: 'destructive' as const,
                onClick: () => {
                  setRevoking(invite)
                  setIsRevoking(true)
                },
              },
            ]}
          />
        )
      },
    },
  ]

  return (
    <>
      <Table<InviteRow> data={invites as InviteRow[]} columns={columns} idKey="id" hasHover textOverflow="truncate" />
      <AlertDialog
        isOpen={isRevoking}
        onOpenChange={(open) => !open && setIsRevoking(false)}
        title={revoking ? `Revoke ${inviteName(revoking)}?` : ''}
        description="The link stops working immediately. People who already joined with it stay members."
        actionLabel="Revoke"
        isActionLoading={revokeInvite.isPending}
        onAction={() =>
          revoking &&
          revokeInvite.mutate(
            { id: revoking.id },
            {
              onSuccess: () => showToast({ body: 'Invite revoked' }),
              onError: (error) => showToast({ body: errorMessage(error), type: 'error' }),
              onSettled: () => setIsRevoking(false),
            },
          )
        }
      />
      {shown?.url ? (
        <FormDialog isOpen onClose={() => setShown(null)} title="Invite link" subtitle="Select the link and copy it by hand.">
          <CopyField label="Invite link" value={shown.url} copyLabel="Copy link" />
        </FormDialog>
      ) : null}
    </>
  )
}

export default function MembersPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'invites' ? 'invites' : 'members'
  const members = useMembers()
  const invites = useInvites()
  const [dialog, setDialog] = useState<'invite' | 'add' | null>(null)

  // Who can connect now: a banned member is on the roster but is refused.
  const admitted = members.data?.members.filter((member) => !member.banned)
  const people = admitted?.filter((member) => member.kind === 'person').length
  const agents = admitted?.filter((member) => member.kind === 'agent').length
  const activeInvites = invites.data?.invites.filter((invite) => invite.state === 'active').length ?? 0

  return (
    <Page
      title="Members"
      summary={
        people === undefined
          ? 'Everyone who can connect to this community.'
          : `${plural(people, 'person', 'people')} and ${plural(agents ?? 0, 'agent')} can connect.`
      }
      actions={
        <>
          <Button label="Add by key" variant="secondary" onClick={() => setDialog('add')} />
          <Button label="Invite people" variant="primary" onClick={() => setDialog('invite')} />
        </>
      }
      toolbar={
        <TabList value={view} onChange={(value) => setParams(value === 'invites' ? { view: 'invites' } : {}, { replace: true })}>
          <Tab value="members" label="Members" />
          <Tab value="invites" label={activeInvites > 0 ? `Invites (${formatCount(activeInvites)} active)` : 'Invites'} />
        </TabList>
      }>
      {view === 'members' ? (
        <QueryState query={members}>{(data) => <MembersTable members={data.members} onInvite={() => setDialog('invite')} />}</QueryState>
      ) : (
        <QueryState query={invites}>{(data) => <InvitesTable invites={data.invites} onCreate={() => setDialog('invite')} />}</QueryState>
      )}
      {dialog === 'invite' ? <InviteDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'add' ? <AddMemberDialog onClose={() => setDialog(null)} /> : null}
    </Page>
  )
}
