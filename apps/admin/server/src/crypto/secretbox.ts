import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Encryption at rest for the few secrets the console must be able to read
// back: hosted-agent keys and the invite links it minted. AES-256-GCM with a
// fresh nonce per value; the context string is bound as associated data so a
// ciphertext cannot be moved from one column or row to another.

export interface SecretBox {
  seal(plaintext: string, context: string): string
  open(sealed: string, context: string): string
}

const VERSION = 'v1'

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('CONSOLE_ENCRYPTION_KEY must be 32 bytes, base64-encoded')

  return {
    seal(plaintext, context) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(context))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return [VERSION, nonce.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
    },
    open(sealed, context) {
      const [version, nonce, body, tag] = sealed.split('.')
      if (version !== VERSION || !nonce || body === undefined || !tag) throw new Error('unrecognized sealed value')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    },
  }
}
