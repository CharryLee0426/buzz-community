import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

// Stored format: scrypt$<log2 N>$<r>$<p>$<salt b64url>$<hash b64url>
// The parameters travel with the hash so they can be raised later without
// invalidating an existing password.
const DEFAULTS = { logN: 16, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const
const MAX_LOG_N = 20

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function scryptOptions(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN
  // scrypt needs roughly 128 * N * r bytes; give it headroom over the default cap.
  return { N, r, p, maxmem: 256 * N * r }
}

export async function hashPassword(password: string): Promise<string> {
  const { logN, r, p, keyLength, saltLength } = DEFAULTS
  const salt = randomBytes(saltLength)
  const key = await derive(password, salt, keyLength, scryptOptions(logN, r, p))
  return ['scrypt', logN, r, p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export function isPasswordHash(value: string): boolean {
  return parseHash(value) !== null
}

function parseHash(stored: string) {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (!Number.isInteger(logN) || logN < 14 || logN > MAX_LOG_N) return null
  if (!Number.isInteger(r) || r < 1 || r > 32) return null
  if (!Number.isInteger(p) || p < 1 || p > 16) return null
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const hash = Buffer.from(parts[5] ?? '', 'base64url')
  if (salt.length < 8 || hash.length < 16) return null
  return { logN, r, p, salt, hash }
}

/** Constant-time check. A malformed stored hash verifies as false rather than throwing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored)
  if (!parsed) return false
  const key = await derive(password, parsed.salt, parsed.hash.length, scryptOptions(parsed.logN, parsed.r, parsed.p))
  return timingSafeEqual(key, parsed.hash)
}
