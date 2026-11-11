import type { StatusDotVariant } from '@astryxdesign/core/StatusDot'
import type { AlertSeverity } from './types'

/** A state as the console shows it: a dot color, and the words that carry the meaning. */
export interface StatusView {
  variant: StatusDotVariant
  label: string
  /** Something is in progress, so the dot pulses. */
  active?: boolean
}

/** How a Railway deployment status reads in this console. */
export function deploymentStatus(status: string | undefined): StatusView {
  switch (status) {
    case 'SUCCESS':
      return { variant: 'success', label: 'Running' }
    case 'BUILDING':
      return { variant: 'accent', label: 'Building', active: true }
    case 'DEPLOYING':
    case 'INITIALIZING':
    case 'WAITING':
    case 'QUEUED':
      return { variant: 'accent', label: 'Deploying', active: true }
    case 'CRASHED':
      return { variant: 'error', label: 'Crashed' }
    case 'FAILED':
      return { variant: 'error', label: 'Deploy failed' }
    case 'SLEEPING':
      return { variant: 'neutral', label: 'Sleeping' }
    case 'REMOVED':
    case 'REMOVING':
      return { variant: 'neutral', label: 'Removed' }
    case 'SKIPPED':
      return { variant: 'neutral', label: 'Skipped' }
    case 'NEEDS_APPROVAL':
      return { variant: 'warning', label: 'Needs approval' }
    case undefined:
      return { variant: 'neutral', label: 'Never deployed' }
    default:
      return { variant: 'neutral', label: status.toLowerCase() }
  }
}

export const SEVERITY: Record<AlertSeverity, StatusView> = {
  critical: { variant: 'error', label: 'Critical' },
  warning: { variant: 'warning', label: 'Warning' },
  notice: { variant: 'accent', label: 'Notice' },
  info: { variant: 'neutral', label: 'Info' },
}

export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI-compatible',
  openrouter: 'OpenRouter',
}
