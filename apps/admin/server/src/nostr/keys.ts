import { createHash, randomBytes } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event, type EventTemplate } from 'nostr-tools'

const HEX_KEY = /^[0-9a-f]{64}$/

export interface Signer {
  /** x-only public key, 64 lowercase hex. */
  readonly pubkey: string
  sign(template: EventTemplate): Event
  /** Schnorr signature (hex) over an arbitrary 32-byte digest given as hex. */
  signDigest(digestHex: string): string
}

/** Accepts a secret key as 64 hex characters or as an nsec. */
export function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim()
  if (HEX_KEY.test(trimmed.toLowerCase())) return Buffer.from(trimmed.toLowerCase(), 'hex')
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type === 'nsec') return decoded.data
  }
  throw new Error('secret key must be 64 hex characters or an nsec')
}

/** Accepts a public key as 64 hex characters or as an npub; returns hex, or null when it is neither. */
export function parsePublicKey(value: string): string | null {
  const trimmed = value.trim()
  if (HEX_KEY.test(trimmed.toLowerCase())) return trimmed.toLowerCase()
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed)
      if (decoded.type === 'npub') return decoded.data
    } catch {
      return null
    }
  }
  return null
}

export function toNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex)
}

export function createSigner(secretKey: Uint8Array): Signer {
  return {
    pubkey: getPublicKey(secretKey),
    sign: (template) => finalizeEvent(template, secretKey),
    signDigest: (digestHex) => Buffer.from(schnorr.sign(Buffer.from(digestHex, 'hex'), secretKey)).toString('hex'),
  }
}

export function newSecretKeyHex(): string {
  return Buffer.from(generateSecretKey()).toString('hex')
}

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
export const randomHex = (bytes: number) => randomBytes(bytes).toString('hex')

/** Unix time in seconds, the unit every Nostr timestamp uses. */
export const unixNow = () => Math.floor(Date.now() / 1000)
