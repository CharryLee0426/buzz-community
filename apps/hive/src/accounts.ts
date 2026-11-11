import { appendFileSync, chmodSync, chownSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

// Every agent runs as its own Unix user with a private home. One agent's
// shell cannot read another's key, files or environment, and cannot read
// this supervisor's, which runs as root and holds the provider keys.

const FIRST_UID = 20_000

export interface Account {
  user: string
  home: string
  /** Absent when the host is not root and so cannot switch users (local runs and tests). */
  uid?: number
  gid?: number
}

export interface Accounts {
  ensure(agentId: string): Account
  remove(agentId: string): void
  /** False when agents share this process's user, which is only acceptable off a server. */
  readonly isolated: boolean
}

export function createAccounts(root: string): Accounts {
  const isolated = typeof process.getuid === 'function' && process.getuid() === 0
  const accounts = new Map<string, Account>()
  let next = FIRST_UID

  mkdirSync(root, { recursive: true })
  // Traversable, not listable: an agent can reach its own home and learn nothing about the others.
  if (isolated) chmodSync(root, 0o711)

  return {
    isolated,
    ensure(agentId) {
      const existing = accounts.get(agentId)
      if (existing) return existing

      const home = path.join(root, agentId)
      const account: Account = { user: `agent${next - FIRST_UID}`, home }
      mkdirSync(path.join(home, '.tmp'), { recursive: true, mode: 0o700 })
      if (isolated) {
        const id = next++
        account.uid = id
        account.gid = id
        // git and ssh look the current user up by id and fail without an entry.
        appendFileSync('/etc/passwd', `${account.user}:x:${id}:${id}:hosted agent:${home}:/bin/sh\n`)
        appendFileSync('/etc/group', `${account.user}:x:${id}:\n`)
        chownSync(home, id, id)
        chownSync(path.join(home, '.tmp'), id, id)
        chmodSync(home, 0o700)
      } else {
        next++
      }
      accounts.set(agentId, account)
      return account
    },
    remove(agentId) {
      const account = accounts.get(agentId)
      if (!account) return
      rmSync(account.home, { recursive: true, force: true })
      accounts.delete(agentId)
    },
  }
}
