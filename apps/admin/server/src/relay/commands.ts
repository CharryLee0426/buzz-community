import { unixNow, type Signer } from '../nostr/keys.js'
import { cleanRefusal, RelayError, type RelayClient } from './client.js'

// Community changes go to the relay as signed events, the same way the Buzz
// app sends them. Writing the tables directly would skip the roster event,
// cache invalidation and session revocation the relay performs.

export type MemberRole = 'admin' | 'member'

export interface MintedInvite {
  code: string
  url: string
  /** Unix seconds. */
  expiresAt: number
  maxUses: number | null
}

export interface RelayCommands {
  addMember(pubkey: string, role: MemberRole): Promise<void>
  removeMember(pubkey: string): Promise<void>
  setRole(pubkey: string, role: MemberRole): Promise<void>
  ban(pubkey: string, options?: { reason?: string; expiresAt?: number }): Promise<void>
  unban(pubkey: string): Promise<void>
  createInvite(options: { ttlSeconds: number; maxUses: number | null }): Promise<MintedInvite>
}

const KIND = { addMember: 9030, removeMember: 9031, setRole: 9032, ban: 9040, unban: 9041 } as const

interface EventReceipt {
  event_id?: string
  accepted?: boolean
  message?: string
}

export function createRelayCommands(relay: RelayClient, signer: Signer): RelayCommands {
  /** Signs and submits one command event; the relay answers 200 even when it refuses. */
  async function submit(kind: number, tags: string[][]) {
    const event = signer.sign({ kind, created_at: unixNow(), content: '', tags })
    const { data } = await relay.request<EventReceipt>({ method: 'POST', path: '/events', body: event, signer })
    if (data?.accepted === false) {
      throw new RelayError(cleanRefusal(data.message), 422, data)
    }
  }

  return {
    addMember: (pubkey, role) => submit(KIND.addMember, [['p', pubkey], ['role', role]]),
    removeMember: (pubkey) => submit(KIND.removeMember, [['p', pubkey]]),
    setRole: (pubkey, role) => submit(KIND.setRole, [['p', pubkey], ['role', role]]),
    ban: (pubkey, options = {}) => {
      const tags = [['p', pubkey]]
      if (options.expiresAt) tags.push(['expiration', String(options.expiresAt)])
      if (options.reason) tags.push(['reason', options.reason])
      return submit(KIND.ban, tags)
    },
    unban: (pubkey) => submit(KIND.unban, [['p', pubkey]]),

    async createInvite({ ttlSeconds, maxUses }) {
      const { data } = await relay.request<{ code: string; url: string; expires_at: number; max_uses: number | null }>({
        method: 'POST',
        path: '/api/invites',
        body: { ttl_secs: ttlSeconds, max_uses: maxUses },
        signer,
      })
      if (!data?.code || !data.url) throw new RelayError('The relay did not return an invite link.', 502, data)
      return { code: data.code, url: data.url, expiresAt: data.expires_at, maxUses: data.max_uses ?? null }
    },
  }
}
