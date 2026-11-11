import { describe, expect, it } from 'vitest'
import { verifyEvent } from 'nostr-tools'
import { createSecretBox } from '../crypto/secretbox.js'
import { nip98Header } from '../relay/client.js'
import { createAuthTag, verifyAuthTag } from './attestation.js'
import { createSigner, parsePublicKey, parseSecretKey, sha256Hex, toNpub } from './keys.js'

// Test vector from NIP-OA: owner secret 0x…01, agent secret 0x…02.
const OWNER_SECRET = '0000000000000000000000000000000000000000000000000000000000000001'
const OWNER_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const AGENT_PUBKEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const SPEC_TAG = [
  'auth',
  OWNER_PUBKEY,
  'kind=1&created_at<1713957000',
  '8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369',
]

describe('keys', () => {
  it('reads secret and public keys in hex and bech32', () => {
    const signer = createSigner(parseSecretKey(OWNER_SECRET))
    expect(signer.pubkey).toBe(OWNER_PUBKEY)
    expect(parsePublicKey(toNpub(OWNER_PUBKEY))).toBe(OWNER_PUBKEY)
    expect(parsePublicKey(OWNER_PUBKEY.toUpperCase())).toBe(OWNER_PUBKEY)
    expect(parsePublicKey('npub1notakey')).toBeNull()
    expect(parsePublicKey('hello')).toBeNull()
    expect(() => parseSecretKey('nope')).toThrow()
  })
})

describe('owner attestation', () => {
  it('accepts the vector from the specification', () => {
    const result = verifyAuthTag(SPEC_TAG, AGENT_PUBKEY)
    expect(result).toMatchObject({ ok: true, owner: OWNER_PUBKEY })
    expect(verifyAuthTag(JSON.stringify(SPEC_TAG), AGENT_PUBKEY).ok).toBe(true)
  })

  it('rejects a tag issued for another agent, or altered', () => {
    expect(verifyAuthTag(SPEC_TAG, OWNER_PUBKEY).ok).toBe(false)
    expect(verifyAuthTag([...SPEC_TAG.slice(0, 2), 'kind=9', SPEC_TAG[3]], AGENT_PUBKEY).ok).toBe(false)
    expect(verifyAuthTag(['auth', OWNER_PUBKEY, ''], AGENT_PUBKEY).ok).toBe(false)
    expect(verifyAuthTag('not json', AGENT_PUBKEY).ok).toBe(false)
  })

  it('produces tags that verify', () => {
    const owner = createSigner(parseSecretKey(OWNER_SECRET))
    const tag = createAuthTag(owner, AGENT_PUBKEY)
    expect(tag.slice(0, 3)).toEqual(['auth', OWNER_PUBKEY, ''])
    expect(verifyAuthTag(tag, AGENT_PUBKEY)).toMatchObject({ ok: true, owner: OWNER_PUBKEY })
  })
})

describe('NIP-98 header', () => {
  it('signs the URL, method and body hash', () => {
    const signer = createSigner(parseSecretKey(OWNER_SECRET))
    const body = Buffer.from('{"ttl_secs":60}')
    const header = nip98Header(signer, 'https://buzz.example/api/invites', 'POST', body)
    expect(header.startsWith('Nostr ')).toBe(true)
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
    expect(verifyEvent(event)).toBe(true)
    expect(event.kind).toBe(27235)
    const tags = Object.fromEntries(event.tags)
    expect(tags.u).toBe('https://buzz.example/api/invites')
    expect(tags.method).toBe('POST')
    expect(tags.payload).toBe(sha256Hex(body))
    // Two requests in the same second must not share an event id.
    expect(nip98Header(signer, 'https://buzz.example/api/invites', 'POST', body)).not.toBe(header)
  })
})

describe('secret box', () => {
  const box = createSecretBox(Buffer.alloc(32, 7).toString('base64'))

  it('round-trips and binds the value to its context', () => {
    const sealed = box.seal('nsec-material', 'agent:abc')
    expect(sealed).not.toContain('nsec-material')
    expect(box.open(sealed, 'agent:abc')).toBe('nsec-material')
    expect(() => box.open(sealed, 'agent:xyz')).toThrow()
    expect(box.seal('nsec-material', 'agent:abc')).not.toBe(sealed)
  })

  it('rejects tampering and a wrong-sized key', () => {
    const sealed = box.seal('value', 'ctx')
    const parts = sealed.split('.')
    parts[2] = Buffer.from('other').toString('base64url')
    expect(() => box.open(parts.join('.'), 'ctx')).toThrow()
    expect(() => createSecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
