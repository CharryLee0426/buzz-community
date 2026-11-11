// Login throttling. One admin account behind a public URL will be guessed at,
// so failures are counted per client address and across all clients: the first
// slows a single source, the second caps a distributed one.

export interface LoginThrottle {
  /** Seconds the caller must wait before another attempt, or 0 when allowed. */
  retryAfter(clientKey: string, now?: number): number
  recordFailure(clientKey: string, now?: number): void
  recordSuccess(clientKey: string): void
}

interface Bucket {
  failures: number
  lockedUntil: number
  lastFailure: number
}

export interface ThrottleOptions {
  /** Failures allowed before delays start. */
  freeAttempts?: number
  /** First delay in ms; doubles with each further failure. */
  baseDelayMs?: number
  maxDelayMs?: number
  /** A bucket with no failures for this long is forgotten. */
  forgetAfterMs?: number
  /** Failures from all clients, per window, before every login is paused. */
  globalLimit?: number
  globalWindowMs?: number
  maxTrackedClients?: number
}

export function createLoginThrottle(options: ThrottleOptions = {}): LoginThrottle {
  const {
    freeAttempts = 5,
    baseDelayMs = 2_000,
    maxDelayMs = 15 * 60_000,
    forgetAfterMs = 60 * 60_000,
    globalLimit = 60,
    globalWindowMs = 10 * 60_000,
    maxTrackedClients = 10_000,
  } = options

  const buckets = new Map<string, Bucket>()
  let globalFailures: number[] = []

  const prune = (now: number) => {
    globalFailures = globalFailures.filter((at) => now - at < globalWindowMs)
    if (buckets.size <= maxTrackedClients) return
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastFailure > forgetAfterMs && bucket.lockedUntil <= now) buckets.delete(key)
    }
    // Still over the cap: drop the oldest entries so memory stays bounded.
    for (const key of buckets.keys()) {
      if (buckets.size <= maxTrackedClients) break
      buckets.delete(key)
    }
  }

  return {
    retryAfter(clientKey, now = Date.now()) {
      prune(now)
      const waits: number[] = []
      const bucket = buckets.get(clientKey)
      if (bucket && bucket.lockedUntil > now) waits.push(bucket.lockedUntil - now)
      if (globalFailures.length >= globalLimit) {
        const oldest = globalFailures[0] ?? now
        waits.push(oldest + globalWindowMs - now)
      }
      return waits.length ? Math.ceil(Math.max(...waits) / 1000) : 0
    },
    recordFailure(clientKey, now = Date.now()) {
      globalFailures.push(now)
      const previous = buckets.get(clientKey)
      const stale = previous && now - previous.lastFailure > forgetAfterMs
      const failures = (stale ? 0 : (previous?.failures ?? 0)) + 1
      const over = failures - freeAttempts
      const delay = over > 0 ? Math.min(baseDelayMs * 2 ** (over - 1), maxDelayMs) : 0
      buckets.set(clientKey, { failures, lockedUntil: now + delay, lastFailure: now })
      prune(now)
    },
    recordSuccess(clientKey) {
      buckets.delete(clientKey)
    },
  }
}
