#!/usr/bin/env node
// Checks a deployed community from the outside, the way a member's Buzz app
// and an operator's browser reach it, plus what Railway reports about it.
// Read-only: it signs nothing in and changes nothing.
//
//   node scripts/verify.mjs                 the domain in community.config.json
//   node scripts/verify.mjs --host <name>   another hostname, such as the Railway-generated one
//
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { domainStatus, linkedProject, serviceStatuses } from './lib/railway.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'community.config.json'), 'utf8'))
const hostFlag = process.argv.indexOf('--host')
const host = hostFlag > -1 ? process.argv[hostFlag + 1] : config.domain
const origin = `https://${host}`
const TIMEOUT_MS = 10_000

let failures = 0
function report(ok, what, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
}

async function get(path, headers = {}) {
  const response = await fetch(`${origin}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

async function check(what, run) {
  try {
    const detail = await run()
    report(true, what, detail ?? '')
  } catch (error) {
    report(false, what, error.message)
  }
}

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}

console.log(`Checking ${origin}\n`)

console.log('Edge')
await check('the gateway answers its health check', async () => {
  const { status } = await get('/healthz')
  expect(status === 200, `/healthz answered ${status}`)
})
await check('the relay’s private endpoints are not reachable from the internet', async () => {
  for (const path of ['/_status', '/metrics', '/internal/git/policy', '/operator/communities', '/internal/hive/desired']) {
    const { status } = await get(path)
    expect(status === 404, `${path} answered ${status}, expected 404`)
  }
})

console.log('\nRelay')
await check('it describes itself (NIP-11) and requires sign-in', async () => {
  const { status, text } = await get('/', { Accept: 'application/nostr+json' })
  expect(status === 200, `the relay information document answered ${status}`)
  const info = JSON.parse(text)
  const nips = info.supported_nips ?? []
  expect(nips.includes(42), 'NIP-42 (authentication) is not advertised')
  expect(nips.includes(43), 'NIP-43 (membership) is not advertised, so the community is not invite-only')
  return `${info.name ?? 'relay'} ${info.version ?? ''}`.trim()
})
await check('a WebSocket connects and is challenged to authenticate', async () => {
  const message = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${host}`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no authentication challenge within 10 s'))
    }, TIMEOUT_MS)
    socket.onmessage = (event) => {
      clearTimeout(timer)
      socket.close()
      resolve(String(event.data))
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('the WebSocket could not connect'))
    }
  })
  expect(JSON.parse(message)[0] === 'AUTH', `expected an AUTH challenge, got ${message.slice(0, 60)}`)
})
await check('the device-pairing relay accepts WebSocket connections', async () => {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${host}/pair`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no connection within 10 s'))
    }, TIMEOUT_MS)
    socket.onopen = () => {
      clearTimeout(timer)
      socket.close()
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('the WebSocket could not connect'))
    }
  })
})

console.log('\nConsole')
await check('the console is up', async () => {
  const { status } = await get('/admin/healthz')
  expect(status === 200, `/admin/healthz answered ${status}`)
})
await check('it serves the web app with its security headers', async () => {
  const { status, headers, text } = await get('/admin/')
  expect(status === 200, `/admin/ answered ${status}`)
  expect(text.includes('<div id="root">'), 'the page is not the console’s web app')
  expect(headers.get('content-security-policy'), 'no Content-Security-Policy header')
  expect(headers.get('strict-transport-security'), 'no Strict-Transport-Security header')
  expect(headers.get('x-frame-options') || /frame-ancestors/.test(headers.get('content-security-policy')), 'the page can be framed')
})
await check('its API refuses a visitor who is not signed in', async () => {
  const { status, text } = await get('/admin/api/members')
  expect(status === 401, `/admin/api/members answered ${status}, expected 401`)
  expect(JSON.parse(text).error?.code === 'signed_out', 'the refusal is not the console’s own')
})

console.log('\nRailway')
if (!linkedProject()) {
  console.log('  · skipped: this directory is not linked to the Railway project (`railway link`).')
} else {
  await check('every service’s latest deployment succeeded', async () => {
    const statuses = serviceStatuses()
    expect(statuses.length > 0, 'no services found')
    const bad = statuses.filter((service) => service.status !== 'SUCCESS')
    expect(bad.length === 0, bad.map((service) => `${service.name} is ${service.status ?? 'not deployed'}`).join(', '))
    return `${statuses.length} services`
  })
  if (host === config.domain) {
    await check('the domain is verified and its certificate is valid', async () => {
      const status = domainStatus('gateway', config.domain)
      expect(status, `${config.domain} is not attached to the gateway`)
      expect(status.verification?.verified, 'domain ownership is not verified; run `node scripts/dns.mjs`')
      expect(status.certificate?.status === 'CERTIFICATE_STATUS_TYPE_VALID', `certificate status is ${status.certificate?.status}`)
      const expires = status.certificates?.[0]?.expiresAt
      return expires ? `certificate renews before ${expires.slice(0, 10)}` : ''
    })
  }
}

console.log(failures ? `\n✗ ${failures} ${failures === 1 ? 'check' : 'checks'} failed.` : '\n✓ Everything checks out.')
process.exit(failures ? 1 : 0)
