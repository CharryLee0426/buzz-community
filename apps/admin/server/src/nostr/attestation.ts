import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256Hex, type Signer } from './keys.js'

// NIP-OA owner attestation: an owner states that an agent key acts for them.
// The tag an agent carries is ["auth", <owner pubkey>, <conditions>, <signature>],
// where the signature is the owner's Schnorr signature over
// sha256("nostr:agent-auth:" + <agent pubkey> + ":" + <conditions>).

export type AuthTag = ['auth', string, string, string]

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

const preimage = (agentPubkey: string, conditions: string) => sha256Hex(`nostr:agent-auth:${agentPubkey}:${conditions}`)

export function createAuthTag(owner: Signer, agentPubkey: string, conditions = ''): AuthTag {
  return ['auth', owner.pubkey, conditions, owner.signDigest(preimage(agentPubkey, conditions))]
}

/**
 * Parses and verifies a tag an owner produced elsewhere, for example in Buzz
 * under Settings → Security → Authorize external identity. Returns the owner's
 * pubkey, or a reason the tag cannot be used for this agent.
 */
export function verifyAuthTag(
  input: unknown,
  agentPubkey: string,
): { ok: true; tag: AuthTag; owner: string } | { ok: false; reason: string } {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'The attestation is not valid JSON.' }
    }
  }
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== 'auth' || value.some((part) => typeof part !== 'string')) {
    return { ok: false, reason: 'The attestation must be a four-item array that starts with "auth".' }
  }
  const [, owner, conditions, signature] = value as AuthTag
  if (!HEX_64.test(owner) || !HEX_128.test(signature)) {
    return { ok: false, reason: 'The attestation holds a malformed public key or signature.' }
  }
  let valid = false
  try {
    valid = schnorr.verify(Buffer.from(signature, 'hex'), Buffer.from(preimage(agentPubkey, conditions), 'hex'), Buffer.from(owner, 'hex'))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'The signature does not match this agent. It was probably issued for a different key.' }
  return { ok: true, tag: ['auth', owner, conditions, signature], owner }
}
