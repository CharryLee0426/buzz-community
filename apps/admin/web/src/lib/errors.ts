import { ApiError } from './api'

/** A failure as a person should read it: what is wrong, and where to go about it. */
export interface Problem {
  title: string
  description: string
  action?: { label: string; href: string }
}

const OPEN_SETTINGS = { label: 'Open settings', href: '/settings' }

/** Integrations that are not set up. Waiting does not change these, so they are never retried. */
const SETUP: Record<string, Problem> = {
  railway_not_connected: {
    title: 'Railway is not connected',
    description:
      'This page reads logs, metrics and deployments from Railway. Create a project token in Railway and set it as RAILWAY_API_TOKEN on the admin service.',
    action: OPEN_SETTINGS,
  },
  database_unavailable: {
    title: 'No database connection',
    description: 'Community data comes from the relay’s Postgres. Check DATABASE_URL on the admin service and that Postgres is running.',
    action: OPEN_SETTINGS,
  },
  owner_key_missing: {
    title: 'The console has no owner key',
    description: 'Without CONSOLE_SECRET_KEY the console cannot sign changes for the relay.',
    action: OPEN_SETTINGS,
  },
  encryption_key_missing: {
    title: 'The console has no encryption key',
    description: 'Without CONSOLE_ENCRYPTION_KEY the console cannot store the keys of hosted agents.',
    action: OPEN_SETTINGS,
  },
}

const UNREACHABLE = 'The request did not reach the console. Check the connection and retry.'

export function describeError(error: unknown): Problem {
  if (error instanceof ApiError) {
    const setup = SETUP[error.code]
    if (setup) return setup
    if (error.status === 0) return { title: 'Console unreachable', description: UNREACHABLE }
    return { title: 'This could not be loaded', description: error.message }
  }
  return { title: 'This could not be loaded', description: 'Something unexpected went wrong.' }
}

/** One sentence for a toast or a form banner. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.status === 0 ? UNREACHABLE : error.message
  return 'Something unexpected went wrong. Try again.'
}

/** Whether asking again could plausibly succeed: not for a 4xx, and not for a missing integration. */
export function isRetryable(error: unknown) {
  if (!(error instanceof ApiError)) return true
  if (error.code in SETUP) return false
  return error.status === 0 || error.status >= 500
}

/** The session ended on the server: expired, or signed out from another tab. */
export const isSignedOut = (error: unknown) => error instanceof ApiError && error.code === 'signed_out'
