#!/usr/bin/env node
// Shows the DNS records Railway needs for the community's domain, whether
// each one has propagated, and the state of the TLS certificate.
//
//   node scripts/dns.mjs            print the records and their status
//   node scripts/dns.mjs --apply    also create or correct them in Cloudflare
//
// --apply needs CLOUDFLARE_API_TOKEN: a token limited to "Zone → DNS → Edit"
// on the one zone. Without it, add the printed records by hand at your DNS
// provider; any provider works.
//
// The records must be "DNS only" (not proxied): the relay speaks WebSocket
// to clients directly and Railway issues the certificate itself.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { domainStatus } from './lib/railway.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'community.config.json'), 'utf8'))
const apply = process.argv.includes('--apply')

const status = domainStatus('gateway', config.domain)
if (!status) {
  console.error(`✗ ${config.domain} is not attached to the gateway yet. Run \`node scripts/setup.mjs\` first.`)
  process.exit(1)
}

const zone = status.dnsRecords?.[0]?.zone ?? config.domain.split('.').slice(-2).join('.')
const records = [
  ...(status.dnsRecords ?? []).map((record) => ({
    type: record.recordType.replace('DNS_RECORD_TYPE_', ''),
    name: record.fqdn,
    value: record.requiredValue,
    current: record.currentValue || null,
    ok: record.status === 'DNS_RECORD_STATUS_PROPAGATED',
    purpose: 'routes traffic to Railway',
  })),
  ...(status.verification
    ? [
        {
          type: 'TXT',
          name: `${status.verification.dnsHost}.${zone}`,
          value: status.verification.token,
          current: null,
          ok: status.verification.verified,
          purpose: 'proves you control the domain',
        },
      ]
    : []),
]

console.log(`DNS for ${config.domain} (zone ${zone})\n`)
for (const record of records) {
  console.log(`  ${record.ok ? '✓' : '·'} ${record.type.padEnd(5)} ${record.name}`)
  console.log(`          → ${record.value}`)
  console.log(`          ${record.purpose}${record.ok ? '' : record.current ? `; currently ${record.current}` : '; not seen yet'}`)
}
const certificate = status.certificate?.status?.replace('CERTIFICATE_STATUS_TYPE_', '').toLowerCase() ?? 'unknown'
console.log(`\n  TLS certificate: ${certificate}`)

const pending = records.filter((record) => !record.ok)
if (!apply) {
  if (pending.length) {
    console.log('\nAdd the records marked · at your DNS provider, as "DNS only" records, or run this script with --apply for Cloudflare.')
    console.log('Railway issues the certificate within a few minutes of seeing them.')
    process.exit(2)
  }
  console.log('\n✓ DNS is in place.')
  process.exit(0)
}

// ── Cloudflare ───────────────────────────────────────────────────────────
const token = process.env.CLOUDFLARE_API_TOKEN
if (!token) {
  console.error('\n✗ --apply needs CLOUDFLARE_API_TOKEN (a token with Zone → DNS → Edit on this zone).')
  process.exit(1)
}

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    const reason = body.errors?.map((error) => error.message).join('; ') || `HTTP ${response.status}`
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path}: ${reason}`)
  }
  return body.result
}

try {
  const zones = await cloudflare(`/zones?name=${encodeURIComponent(zone)}`)
  if (!zones.length) throw new Error(`The token cannot see a zone named ${zone}.`)
  const zoneId = zones[0].id

  console.log('')
  for (const record of records) {
    const existing = await cloudflare(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)
    // Cloudflare stores TXT content with or without quotes depending on how it was entered.
    const same = (entry) => entry.content.replace(/^"|"$/g, '') === record.value && entry.proxied !== true
    if (existing.some(same)) {
      console.log(`  ✓ ${record.type} ${record.name} is already correct`)
      continue
    }
    const body = JSON.stringify({ type: record.type, name: record.name, content: record.value, ttl: 1, proxied: false })
    if (existing.length && record.type === 'CNAME') {
      // A name holds one CNAME, so a wrong one is replaced, not added to.
      await cloudflare(`/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body })
      console.log(`  ✓ ${record.type} ${record.name} updated`)
    } else {
      await cloudflare(`/zones/${zoneId}/dns_records`, { method: 'POST', body })
      console.log(`  ✓ ${record.type} ${record.name} created`)
    }
  }
  console.log('\nRailway checks DNS every few minutes. Run this script again without --apply to watch the certificate arrive.')
} catch (error) {
  console.error(`\n✗ ${error.message}`)
  process.exit(1)
}
