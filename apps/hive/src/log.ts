// One JSON object per line on stdout, in the shape Railway indexes: `level`
// and `message` at the top, everything else as searchable fields.

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(fields: Fields, message: string): void
  info(fields: Fields, message: string): void
  warn(fields: Fields, message: string): void
  error(fields: Fields, message: string): void
  /** A logger that adds these fields to every line. */
  child(fields: Fields): Logger
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? undefined : serialize(value.cause)
    return { name: value.name, message: value.message, stack: value.stack, ...(cause === undefined ? {} : { cause }) }
  }
  return value
}

export function createLogger(minimum: Level = 'info', base: Fields = {}, write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (level: Level, fields: Fields, message: string) => {
    if (ORDER[level] < ORDER[minimum]) return
    const record: Fields = { level, message, timestamp: new Date().toISOString(), ...base }
    for (const [key, value] of Object.entries(fields)) record[key] = serialize(value)
    write(`${JSON.stringify(record)}\n`)
  }
  return {
    debug: (fields, message) => emit('debug', fields, message),
    info: (fields, message) => emit('info', fields, message),
    warn: (fields, message) => emit('warn', fields, message),
    error: (fields, message) => emit('error', fields, message),
    child: (fields) => createLogger(minimum, { ...base, ...fields }, write),
  }
}

// Color codes, which buzz-acp emits when it thinks it has a terminal. Built from the escape character's code so no control character sits in the source.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
// buzz-acp logs through Rust's `tracing`: "2026-11-11T05:00:00.123456Z  INFO buzz_acp::relay: connected".
const TRACING_PREFIX = /^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+/

/**
 * Reads the level out of a line an agent process wrote, so its warnings and
 * errors keep their severity in Railway instead of all arriving as one level.
 */
export function parseAgentLine(raw: string): { level: Level; message: string } {
  const line = raw.replace(ANSI, '').trimEnd()
  const match = TRACING_PREFIX.exec(line)
  if (!match) return { level: 'info', message: line }
  const level = match[1] === 'ERROR' ? 'error' : match[1] === 'WARN' ? 'warn' : match[1] === 'INFO' ? 'info' : 'debug'
  return { level, message: line.slice(match[0].length) }
}
