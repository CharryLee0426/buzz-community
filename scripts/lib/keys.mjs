// Key and secret helpers shared by the setup scripts. Node built-ins only, so
// the scripts run right after a clone, before any install.

import { createECDH, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

/** A new Nostr secret key as 64 lowercase hex characters. */
export function generateSecretKey() {
  // A random 32-byte string is a valid secp256k1 scalar except with negligible
  // probability; createECDH rejects the rest, so retry until it accepts one.
  for (;;) {
    const candidate = randomBytes(32)
    try {
      publicKeyOf(candidate.toString('hex'))
      return candidate.toString('hex')
    } catch {
      // out of range for the curve; draw again
    }
  }
}

/** The x-only public key (64 hex) Nostr uses for a secret key given as hex. */
export function publicKeyOf(secretKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) throw new Error('secret key must be 64 lowercase hex characters')
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(Buffer.from(secretKeyHex, 'hex'))
  return ecdh.getPublicKey(null, 'compressed').subarray(1).toString('hex')
}

/** URL-safe random text carrying `bytes` bytes of entropy. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Hashes a console password in the format the admin server verifies:
 * scrypt$<log2 N>$<r>$<p>$<salt>$<hash>, both base64url.
 */
export async function hashPassword(password) {
  const [logN, r, p] = [16, 8, 1]
  const N = 2 ** logN
  const salt = randomBytes(16)
  const key = await scryptAsync(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r })
  return ['scrypt', logN, r, p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) checksum ^= generator[i]
  }
  return checksum
}

/** Encodes 32 bytes of hex as NIP-19 bech32 with the given prefix (`npub`, `nsec`). */
export function toBech32(prefix, hex) {
  const bytes = Buffer.from(hex, 'hex')
  const words = []
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      words.push((accumulator >> bits) & 31)
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31)
  const expanded = [...prefix].map((c) => c.charCodeAt(0) >> 5).concat(0, [...prefix].map((c) => c.charCodeAt(0) & 31))
  const polymod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (polymod >> (5 * (5 - i))) & 31)
  return `${prefix}1${[...words, ...checksum].map((word) => BECH32_CHARSET[word]).join('')}`
}
