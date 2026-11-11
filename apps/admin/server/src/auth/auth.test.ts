import { describe, expect, it } from 'vitest'
import { hashPassword, isPasswordHash, verifyPassword } from './password.js'
import { createSessionCodec } from './session.js'
import { createLoginThrottle } from './throttle.js'

describe('password hashing', () => {
  it('verifies the password it hashed and rejects another', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(isPasswordHash(stored)).toBe(true)
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(await verifyPassword('correct horse battery stapler', stored)).toBe(false)
  })

  it('salts each hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('treats a malformed or plaintext stored value as a failed check', async () => {
    for (const stored of ['', 'hunter2', 'scrypt$16$8$1$short$x', 'scrypt$99$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA']) {
      expect(isPasswordHash(stored)).toBe(false)
      expect(await verifyPassword('hunter2', stored)).toBe(false)
    }
  })
})

describe('session tokens', () => {
  const secret = 'x'.repeat(48)
  const codec = createSessionCodec(secret, 3600)

  it('round-trips a session', () => {
    const { token, session } = codec.issue('operator', 1_000_000)
    expect(codec.read(token, 1_000_000)).toEqual(session)
    expect(session.csrf.length).toBeGreaterThan(16)
  })

  it('rejects expired, tampered and foreign tokens', () => {
    const { token } = codec.issue('operator', 1_000_000)
    expect(codec.read(token, 1_000_000 + 3600 * 1000)).toBeNull()

    const [version, payload, signature] = token.split('.') as [string, string, string]
    const forged = Buffer.from(JSON.stringify({ sub: 'root', iat: 0, exp: 9e9, csrf: 'x' })).toString('base64url')
    expect(codec.read(`${version}.${forged}.${signature}`, 1_000_000)).toBeNull()
    expect(codec.read(`${version}.${payload}.${signature.slice(0, -2)}AA`, 1_000_000)).toBeNull()
    expect(createSessionCodec('y'.repeat(48)).read(token, 1_000_000)).toBeNull()
    expect(codec.read(undefined)).toBeNull()
    expect(codec.read('not-a-token')).toBeNull()
  })

  it('asks for renewal in the second half of the lifetime', () => {
    const { session } = codec.issue('operator', 0)
    expect(codec.shouldRenew(session, 1000 * 1000)).toBe(false)
    expect(codec.shouldRenew(session, 2000 * 1000)).toBe(true)
  })

  it('renews without changing the CSRF token', () => {
    const { session } = codec.issue('operator', 0)
    const renewed = codec.renew(session, 2000 * 1000)
    expect(renewed.session.csrf).toBe(session.csrf)
    expect(renewed.session.exp).toBe(2000 + 3600)
    expect(codec.read(renewed.token, 2000 * 1000)).toEqual(renewed.session)
  })

  it('refuses a short signing secret', () => {
    expect(() => createSessionCodec('too-short')).toThrow(/32 bytes/)
  })
})

describe('login throttle', () => {
  it('allows a few mistakes, then backs off exponentially', () => {
    const throttle = createLoginThrottle({ freeAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 })
    let now = 0
    for (let i = 0; i < 3; i++) throttle.recordFailure('a', now)
    expect(throttle.retryAfter('a', now)).toBe(0)

    throttle.recordFailure('a', now)
    expect(throttle.retryAfter('a', now)).toBe(1)
    now += 1000
    expect(throttle.retryAfter('a', now)).toBe(0)

    throttle.recordFailure('a', now)
    expect(throttle.retryAfter('a', now)).toBe(2)
    for (let i = 0; i < 6; i++) throttle.recordFailure('a', now)
    expect(throttle.retryAfter('a', now)).toBe(8)
    expect(throttle.retryAfter('b', now)).toBe(0)
  })

  it('clears a client on success', () => {
    const throttle = createLoginThrottle({ freeAttempts: 1, baseDelayMs: 5000 })
    throttle.recordFailure('a', 0)
    throttle.recordFailure('a', 0)
    expect(throttle.retryAfter('a', 0)).toBe(5)
    throttle.recordSuccess('a')
    expect(throttle.retryAfter('a', 0)).toBe(0)
  })

  it('pauses every client once failures pile up across clients', () => {
    const throttle = createLoginThrottle({ globalLimit: 4, globalWindowMs: 10_000 })
    for (let i = 0; i < 4; i++) throttle.recordFailure(`client-${i}`, 1000)
    expect(throttle.retryAfter('someone-new', 2000)).toBe(9)
    expect(throttle.retryAfter('someone-new', 11_001)).toBe(0)
  })
})
