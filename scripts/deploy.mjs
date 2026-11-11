#!/usr/bin/env node
// Builds and deploys the services whose code lives in this repository. The
// relay, pairing relay, Postgres and Redis run published images and are
// deployed by `railway config apply`, not from here.
//
//   node scripts/deploy.mjs                 gateway, admin and hive, one after another
//   node scripts/deploy.mjs admin           only the named services
//
// Once community.config.json names a GitHub repository, Railway builds these
// services itself on every push to the configured branch and this script is
// only needed to deploy something that has not been pushed.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkedProject, railway } from './lib/railway.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'community.config.json'), 'utf8'))

// Order matters on a first deploy: the gateway's health check does not depend
// on the others, the console must be up before the agent host can report to it.
const BUILT_HERE = ['gateway', 'admin', 'hive']

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const unknown = requested.filter((name) => !BUILT_HERE.includes(name))
if (unknown.length) {
  console.error(`✗ Not built from this repository: ${unknown.join(', ')}. Choose from ${BUILT_HERE.join(', ')}.`)
  process.exit(1)
}
const services = requested.length ? BUILT_HERE.filter((name) => requested.includes(name)) : BUILT_HERE

const linked = linkedProject()
if (!linked) {
  console.error('✗ This directory is not linked to a Railway project. Run `railway link` first.')
  process.exit(1)
}
if (config.github?.repo && !requested.length) {
  console.log(`Railway deploys these services from ${config.github.repo} on every push to ${config.github.branch}.`)
  console.log('Deploying the working tree anyway; name a service to deploy just that one.\n')
}

const WAIT_MS = 15 * 60_000
const failed = []
const unconfirmed = []
for (const service of services) {
  console.log(`\n▸ Deploying ${service}`)
  // --ci streams the build log and returns once the deployment is live or has failed.
  const result = railway(['up', '--service', service, '--ci', '-m', `deploy ${service} from scripts/deploy.mjs`], {
    inherit: true,
    allowFailure: true,
    timeoutMs: WAIT_MS,
  })
  if (result.timedOut) {
    // Railway skips a deployment whose inputs did not change, and the CLI then waits for a result that never comes.
    console.log(`  no result after ${WAIT_MS / 60_000} minutes. If \`railway service list\` shows ${service} as SUCCESS, Railway skipped an identical deployment.`)
    unconfirmed.push(service)
  } else if (!result.ok) {
    failed.push(service)
  }
}

if (failed.length) {
  console.error(`\n✗ Failed: ${failed.join(', ')}. \`railway logs --service <name> --build\` shows the build log.`)
  process.exit(1)
}
const deployed = services.filter((name) => !unconfirmed.includes(name))
console.log(`\n${unconfirmed.length ? '·' : '✓'} Deployed ${deployed.join(', ') || 'nothing new'}. Check the result with: node scripts/verify.mjs`)
