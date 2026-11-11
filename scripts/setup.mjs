#!/usr/bin/env node
// Brings the community up on Railway, and brings it back in line on every
// later run. It is safe to repeat: secrets are generated only when Railway
// does not hold them yet, and everything else is declared in .railway/railway.ts.
//
//   node scripts/setup.mjs            first run asks for the console login
//   node scripts/setup.mjs --plan     show what would change, change nothing
//
// Inputs (environment, all optional after the first run):
//   BUZZ_ADMIN_USERNAME, BUZZ_ADMIN_PASSWORD   console login; a new password replaces the old one
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY   model credentials for hosted agents
//   OPENAI_BASE_URL                   an OpenAI-compatible endpoint other than api.openai.com
//   BUZZ_RAILWAY_API_TOKEN            token the console uses to read logs and metrics
//   BUZZ_ALERT_FORWARD_URL            chat webhook that also receives critical and warning alerts

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, hashPassword, publicKeyOf, randomToken, toBech32 } from './lib/keys.mjs'
import {
  cliVersion,
  domains,
  graphql,
  linkedProject,
  railway,
  variableNames,
  versionAtLeast,
} from './lib/railway.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'community.config.json'), 'utf8'))
const flags = new Set(process.argv.slice(2))
const planOnly = flags.has('--plan')
const MIN_CLI = [5, 63, 0]

const step = (message) => console.log(`\n▸ ${message}`)
const note = (message) => console.log(`  ${message}`)
const fail = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve('')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  return new Promise((resolve) => {
    if (hidden) {
      // Echo nothing while the password is typed.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

// ── Preflight ────────────────────────────────────────────────────────────
step('Checking the Railway CLI and the linked project')
const version = cliVersion()
if (!versionAtLeast(version, MIN_CLI)) {
  fail(`Railway CLI ${version.join('.')} is too old. This setup needs ${MIN_CLI.join('.')} or newer: run \`railway upgrade --yes\`.`)
}
if (!railway(['whoami'], { allowFailure: true }).ok) fail('Not signed in to Railway. Run `railway login`, then run this script again.')

const linked = linkedProject()
if (!linked) {
  fail(
    `This directory is not linked to a Railway project.\n` +
      `  New community:      railway init --name ${config.project}\n` +
      `  Existing community: railway link`,
  )
}
const environment = linked.environment
note(`project ${linked.name} (${linked.id}), environment ${environment?.name ?? 'production'}`)

// ── Secrets ──────────────────────────────────────────────────────────────
step('Checking which secrets Railway already holds')
const held = {
  relay: variableNames('relay'),
  admin: variableNames('admin'),
  hive: variableNames('hive'),
}
const setupEnv = {}
const generated = {}

function ensure(service, variable, setupName, make) {
  if (held[service].has(variable)) return false
  const value = make()
  setupEnv[`BUZZ_SETUP_${setupName}`] = value
  generated[setupName] = value
  return true
}

const hasOwnerKey = held.admin.has('CONSOLE_SECRET_KEY')
const hasOwnerPubkey = held.relay.has('RELAY_OWNER_PUBKEY')
if (hasOwnerKey !== hasOwnerPubkey) {
  fail(
    'The console owner key and the relay owner pubkey are out of step: one exists on Railway and the other does not.\n' +
      '  Restore the missing variable from your secrets backup before running setup again; generating a new key\n' +
      '  would lock the console out of the community it owns.',
  )
}

ensure('relay', 'BUZZ_RELAY_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', generateSecretKey)
ensure('relay', 'BUZZ_GIT_HOOK_HMAC_SECRET', 'GIT_HOOK_HMAC_SECRET', () => randomToken(32))
if (ensure('admin', 'CONSOLE_SECRET_KEY', 'CONSOLE_SECRET_KEY', generateSecretKey)) {
  setupEnv.BUZZ_SETUP_RELAY_OWNER_PUBKEY = publicKeyOf(generated.CONSOLE_SECRET_KEY)
}
ensure('admin', 'SESSION_SECRET', 'SESSION_SECRET', () => randomToken(48))
ensure('admin', 'CONSOLE_ENCRYPTION_KEY', 'CONSOLE_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'))
ensure('admin', 'HIVE_TOKEN', 'HIVE_TOKEN', () => randomToken(32))
ensure('admin', 'WEBHOOK_TOKEN', 'WEBHOOK_TOKEN', () => randomToken(32))

// Console login. Required once; afterwards only a supplied value changes it.
let username = process.env.BUZZ_ADMIN_USERNAME?.trim()
let password = process.env.BUZZ_ADMIN_PASSWORD
if (!held.admin.has('ADMIN_USERNAME') && !username && !planOnly) username = await ask('Console username: ')
if (!held.admin.has('ADMIN_PASSWORD_HASH') && !password && !planOnly) password = await ask('Console password: ', { hidden: true })
if (!planOnly) {
  if (!held.admin.has('ADMIN_USERNAME') && !username) fail('A console username is required on the first run. Set BUZZ_ADMIN_USERNAME.')
  if (!held.admin.has('ADMIN_PASSWORD_HASH') && !password) fail('A console password is required on the first run. Set BUZZ_ADMIN_PASSWORD.')
}
if (username) setupEnv.BUZZ_SETUP_ADMIN_USERNAME = username
if (password) {
  if (password.length < 12) fail('The console password must be at least 12 characters.')
  setupEnv.BUZZ_SETUP_ADMIN_PASSWORD_HASH = await hashPassword(password)
}

// Credentials supplied by the operator are passed through when present.
const passThrough = {
  RAILWAY_API_TOKEN: process.env.BUZZ_RAILWAY_API_TOKEN,
  ALERT_FORWARD_URL: process.env.BUZZ_ALERT_FORWARD_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}
for (const [name, value] of Object.entries(passThrough)) {
  if (value) setupEnv[`BUZZ_SETUP_${name}`] = value
}

const newNames = Object.keys(generated)
note(newNames.length ? `generating: ${newNames.join(', ')}` : 'every generated secret is already in place')
if (username) note('console username will be set')
if (password) note('console password will be set')

// ── Custom domain ────────────────────────────────────────────────────────
// Railway configuration manages a custom domain but cannot register one, so
// the first apply leaves it out and `railway domain` registers it afterwards.
const gatewayDomains = domains('gateway')
const domainRegistered = gatewayDomains.some((entry) => entry.type === 'custom' && entry.domain === config.domain)
if (!domainRegistered) setupEnv.BUZZ_SETUP_DOMAIN_PENDING = '1'

// ── Apply ────────────────────────────────────────────────────────────────
if (planOnly) {
  step('Planning (nothing will change)')
  railway(['config', 'plan'], { env: setupEnv, inherit: true })
  process.exit(0)
}

// Keep a private copy of what was generated before it leaves this machine:
// the relay key and the owner key cannot be recreated.
if (newNames.length) {
  const dir = join(root, '.secrets')
  const file = join(dir, `${linked.name}.${environment?.name ?? 'production'}.json`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const backup = {
    ...previous,
    ...generated,
    ...(generated.CONSOLE_SECRET_KEY
      ? {
          CONSOLE_PUBLIC_KEY: publicKeyOf(generated.CONSOLE_SECRET_KEY),
          CONSOLE_NPUB: toBech32('npub', publicKeyOf(generated.CONSOLE_SECRET_KEY)),
        }
      : {}),
    savedAt: new Date().toISOString(),
  }
  writeFileSync(file, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  step('Saved a backup of the new secrets')
  note(file)
  note('Move it into a password manager. It is git-ignored and must never be committed.')
}

step('Applying .railway/railway.ts')
railway(['config', 'apply', '--yes'], { env: setupEnv, inherit: true })

if (!domainRegistered) {
  step(`Registering ${config.domain} on the gateway`)
  railway(['domain', config.domain, '--service', 'gateway', '--port', '8080'], { inherit: true })
  note('Applying again so the configuration owns the domain')
  railway(['config', 'apply', '--yes'], { inherit: true })
}

// A Railway-provided hostname lets you check the gateway before DNS exists.
// `railway domain` only prints the custom domain once one is attached, so the
// hostname is created through the API.
if (!gatewayDomains.some((entry) => entry.type === 'service')) {
  step('Generating a Railway hostname for the gateway')
  const gateway = linkedProject().services.find((service) => service.name === 'gateway')
  if (gateway && environment) {
    const { serviceDomainCreate } = graphql(
      `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { serviceId: gateway.id, environmentId: environment.id, targetPort: 8080 } },
    )
    note(`https://${serviceDomainCreate.domain}`)
  } else {
    note('skipped: the gateway service was not found. Run this script again once the apply has finished.')
  }
}

step('Next steps')
note('1. Deploy the services built from this repository:  node scripts/deploy.mjs')
note('2. Point DNS at Railway:                             node scripts/dns.mjs')
note('3. Check everything end to end:                      node scripts/verify.mjs')
