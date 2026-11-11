import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, setCsrfToken } from './api'

export interface SessionInfo {
  username: string
  csrf: string
}

export const SESSION_KEY = ['session'] as const

async function fetchSession(): Promise<SessionInfo | null> {
  try {
    const session = await api<SessionInfo>('/session')
    setCsrfToken(session.csrf)
    return session
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(undefined)
      return null
    }
    throw error
  }
}

/** `data` is null when signed out, undefined while the first check is running. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500 && error.status !== 0) && count < 2,
  })
}

export function useSignIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api<SessionInfo>('/session', { method: 'POST', body: credentials }),
    onSuccess: (session) => {
      setCsrfToken(session.csrf)
      queryClient.setQueryData(SESSION_KEY, session)
    },
  })
}

export function useSignOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<void>('/session', { method: 'DELETE' }),
    // Only once the server has ended the session; otherwise the cookie is still good and the next check signs back in.
    onSuccess: () => {
      setCsrfToken(undefined)
      // Drop every cached response: it belonged to the session that just ended.
      queryClient.clear()
      queryClient.setQueryData(SESSION_KEY, null)
    },
  })
}
