// Formatting shared by every page, so the same quantity never reads two ways.

const integer = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const formatCount = (value: number) => integer.format(value)

/** 1,234 stays exact; 12,345 becomes 12.3K. For tiles, where width is fixed. */
export const formatCompact = (value: number) => (Math.abs(value) < 10_000 ? integer.format(value) : compact.format(value))

/** A public key is 64 hex characters; show enough of each end to tell two apart. */
export function shortKey(key: string, head = 10, tail = 6) {
  return key.length <= head + tail + 1 ? key : `${key.slice(0, head)}…${key.slice(-tail)}`
}

export function formatDuration(seconds: number) {
  if (seconds < 90) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 36) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} d`
}

/** Railway reports memory and disk in gigabytes; most services here use megabytes. */
export function formatGigabytes(value: number) {
  if (value < 0.001) return `${Math.round(value * 1024 * 1024)} KB`
  if (value < 1) return `${Math.round(value * 1024)} MB`
  return `${value.toFixed(value < 10 ? 2 : 1)} GB`
}

/** CPU arrives as cores in use; a third of a core reads better as 0.33 vCPU. */
export function formatCpu(value: number) {
  if (value < 0.01) return '<0.01 vCPU'
  return `${value.toFixed(2)} vCPU`
}

export function formatRate(perMinute: number) {
  if (perMinute === 0) return '0/min'
  if (perMinute < 0.1) return `${perMinute.toFixed(2)}/min`
  // Below ten, the tenths are the difference between two axis ticks.
  if (perMinute < 10 && !Number.isInteger(perMinute)) return `${perMinute.toFixed(1)}/min`
  return `${integer.format(Math.round(perMinute))}/min`
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const clockSeconds = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const dayAndClock = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** Axis label for a chart tick: clock time within two days, the date beyond. */
export function formatTick(at: number, windowHours: number) {
  return windowHours <= 48 ? clock.format(at) : day.format(at)
}

export const formatMoment = (at: number) => dayAndClock.format(at)

/** "1 member", "3 members": a count with its noun. */
export const plural = (count: number, one: string, many = `${one}s`) => `${integer.format(count)} ${count === 1 ? one : many}`

/** Log timestamps: seconds matter, the date mostly does not. */
export function formatLogTime(at: string) {
  const date = new Date(at)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? clockSeconds.format(date) : `${day.format(date)} ${clockSeconds.format(date)}`
}
