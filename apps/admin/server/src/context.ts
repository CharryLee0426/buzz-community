import type { SessionCodec } from './auth/session.js'
import type { LoginThrottle } from './auth/throttle.js'
import type { Config } from './config.js'
import type { SecretBox } from './crypto/secretbox.js'
import type { CommunityStore } from './db/community.js'
import type { ConsoleStore } from './db/console.js'
import type { Logger } from './log.js'
import type { Signer } from './nostr/keys.js'
import type { RailwayClient } from './railway/client.js'
import type { RelayClient } from './relay/client.js'
import type { RelayCommands } from './relay/commands.js'

/**
 * Everything a request handler can reach. Optional members are integrations
 * the console runs without: with no database the community pages explain what
 * is missing while sign-in and the Railway views keep working, and the reverse.
 */
export interface AppContext {
  config: Config
  log: Logger
  sessions: SessionCodec
  throttle: LoginThrottle
  communityHost: string
  relay: RelayClient
  /** Owner key of the community; absent until setup has provided it. */
  signer?: Signer
  commands?: RelayCommands
  box?: SecretBox
  community?: CommunityStore
  store?: ConsoleStore
  railway?: RailwayClient
  /** What the agent host last told us about itself. */
  hive: HiveState
  cache: Cache
}

export interface HiveState {
  lastSeenAt: number | null
  providers: Record<string, boolean>
  version: string | null
}

/** The host reports every 15 s; after this long without a report it counts as offline. */
export const HIVE_STALE_MS = 90_000

export function hiveOnline(hive: HiveState): boolean {
  return hive.lastSeenAt !== null && Date.now() - hive.lastSeenAt <= HIVE_STALE_MS
}

export interface Cache {
  /** Returns a fresh value at most once per `ttlMs`; concurrent callers share one load. */
  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>
  invalidate(prefix: string): void
}

export function createCache(): Cache {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>()
  return {
    get<T>(key: string, ttlMs: number, load: () => Promise<T>) {
      const hit = entries.get(key)
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
      const value = load()
      entries.set(key, { at: Date.now(), value })
      // A failed load must not be served again from cache.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key)
      })
      return value
    },
    invalidate(prefix) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

/** An error whose message is safe to show the operator, with the HTTP status to send. */
export class ApiProblem extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiProblem'
  }
}

export function requireCommunity(ctx: AppContext): CommunityStore {
  if (!ctx.community) {
    throw new ApiProblem(503, 'database_unavailable', 'The console has no database connection, so community data is unavailable. Set DATABASE_URL on the admin service.')
  }
  return ctx.community
}

export function requireStore(ctx: AppContext): ConsoleStore {
  if (!ctx.store) {
    throw new ApiProblem(503, 'database_unavailable', 'The console has no database connection. Set DATABASE_URL on the admin service.')
  }
  return ctx.store
}

export function requireCommands(ctx: AppContext): { commands: RelayCommands; signer: Signer } {
  if (!ctx.commands || !ctx.signer) {
    throw new ApiProblem(503, 'owner_key_missing', 'The console has no community owner key, so it cannot change members or invites. Set CONSOLE_SECRET_KEY on the admin service.')
  }
  return { commands: ctx.commands, signer: ctx.signer }
}

export function requireRailway(ctx: AppContext): RailwayClient {
  if (!ctx.railway) {
    throw new ApiProblem(503, 'railway_not_connected', 'Railway is not connected. Create a project token in Railway and set RAILWAY_API_TOKEN on the admin service.')
  }
  return ctx.railway
}
