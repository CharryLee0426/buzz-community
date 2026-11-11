import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { api, type RequestOptions } from './api'
import type {
  AgentsResponse,
  AlertRecord,
  AuditEntry,
  Channel,
  Deployment,
  HostedAgent,
  Invite,
  LogLine,
  Member,
  MetricsResponse,
  Overview,
  ServiceUsage,
  Settings,
} from './types'

// One hook per screenful of data. Live operational views refetch on a timer;
// lists a person edits refetch after the edit instead.

const LIVE = 30_000

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: LIVE })

export const useMembers = () =>
  useQuery({ queryKey: ['members'], queryFn: () => api<{ consolePubkey: string | null; members: Member[] }>('/members') })

export const useInvites = () => useQuery({ queryKey: ['invites'], queryFn: () => api<{ invites: Invite[] }>('/invites') })

export const useChannels = () =>
  useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ channels: Channel[]; privateChannels: number; directMessages: number }>('/channels'),
  })

export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => api<AgentsResponse>('/agents'), refetchInterval: LIVE })

export const useServices = () =>
  useQuery({ queryKey: ['services'], queryFn: () => api<{ services: ServiceUsage[] }>('/services'), refetchInterval: LIVE })

export const useMetrics = (hours: number) =>
  useQuery({
    queryKey: ['metrics', hours],
    queryFn: () => api<MetricsResponse>('/metrics', { query: { hours } }),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  })

export interface LogFilters {
  service?: string
  level?: string
  q?: string
}

export const useLogs = (filters: LogFilters, live: boolean) =>
  useQuery({
    queryKey: ['logs', filters],
    queryFn: () =>
      api<{ services: { id: string; name: string }[]; lines: LogLine[] }>('/logs', { query: { ...filters, limit: 300 } }),
    refetchInterval: live ? 5_000 : false,
    placeholderData: (previous) => previous,
  })

export const useDeployments = () =>
  useQuery({ queryKey: ['deployments'], queryFn: () => api<{ deployments: Deployment[] }>('/deployments'), refetchInterval: LIVE })

export const useAlerts = () =>
  useQuery({
    queryKey: ['alerts'],
    queryFn: () => api<{ alerts: AlertRecord[]; open: number; receiving: boolean; forwarding: boolean }>('/alerts'),
    refetchInterval: LIVE,
  })

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings'), refetchInterval: LIVE })

export const useAudit = () => useQuery({ queryKey: ['audit'], queryFn: () => api<{ entries: AuditEntry[] }>('/audit', { query: { limit: 100 } }) })

/** A write that refreshes the lists it affects when it succeeds. */
export function useWrite<TInput, TResult = unknown>(
  request: (input: TInput) => { path: string } & RequestOptions,
  invalidates: QueryKey[],
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => {
      const { path, ...options } = request(input)
      return api<TResult>(path, options)
    },
    // Also after a failure: a 404 means the row is already gone, and the list should say so.
    onSettled: () => Promise.all(invalidates.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  })
}

const COMMUNITY: QueryKey[] = [['members'], ['invites'], ['overview']]

export const useAddMember = () =>
  useWrite<{ pubkey: string; role: 'member' | 'admin' }>((body) => ({ path: '/members', method: 'POST', body }), COMMUNITY)

export const useSetRole = () =>
  useWrite<{ pubkey: string; role: 'member' | 'admin' }>(
    ({ pubkey, role }) => ({ path: `/members/${pubkey}`, method: 'PATCH', body: { role } }),
    COMMUNITY,
  )

export const useRemoveMember = () =>
  useWrite<{ pubkey: string }>(({ pubkey }) => ({ path: `/members/${pubkey}`, method: 'DELETE' }), COMMUNITY)

export const useBanMember = () =>
  useWrite<{ pubkey: string }>(({ pubkey }) => ({ path: `/members/${pubkey}/ban`, method: 'POST', body: {} }), COMMUNITY)

export const useUnbanMember = () =>
  useWrite<{ pubkey: string }>(({ pubkey }) => ({ path: `/members/${pubkey}/ban`, method: 'DELETE' }), COMMUNITY)

export const useCreateInvite = () =>
  useWrite<{ ttlHours: number; maxUses: number | null; note: string }, { url: string; expiresAt: string; maxUses: number | null; saved: boolean }>(
    (body) => ({ path: '/invites', method: 'POST', body }),
    COMMUNITY,
  )

export const useRevokeInvite = () =>
  useWrite<{ id: string }>(({ id }) => ({ path: `/invites/${id}`, method: 'DELETE' }), COMMUNITY)

const AGENTS: QueryKey[] = [['agents'], ['members'], ['overview']]

export type NewAgentInput =
  | { kind: 'personal'; owner: string; name: string; about: string; provider: string; model: string; instructions: string }
  | {
      kind: 'shared'
      access: 'allowlist' | 'anyone'
      allowlist: string[]
      name: string
      about: string
      provider: string
      model: string
      instructions: string
    }

export const useCreateAgent = () =>
  useWrite<NewAgentInput, HostedAgent>((body) => ({ path: '/agents', method: 'POST', body }), AGENTS)

export const useUpdateAgent = () =>
  useWrite<{ id: string; changes: Record<string, unknown> }, HostedAgent>(
    ({ id, changes }) => ({ path: `/agents/${id}`, method: 'PATCH', body: changes }),
    AGENTS,
  )

export const useAuthorizeAgent = () =>
  useWrite<{ id: string; tag: string }, HostedAgent>(
    ({ id, tag }) => ({ path: `/agents/${id}/authorization`, method: 'POST', body: { tag } }),
    AGENTS,
  )

export const useDeleteAgent = () =>
  useWrite<{ id: string }, { membershipRemoved: boolean }>(({ id }) => ({ path: `/agents/${id}`, method: 'DELETE' }), AGENTS)

export const useAcknowledgeAlert = () =>
  useWrite<{ id: string }>(({ id }) => ({ path: `/alerts/${id}/acknowledge`, method: 'POST' }), [['alerts'], ['overview']])
