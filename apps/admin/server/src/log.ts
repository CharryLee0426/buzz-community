import { trace } from '@opentelemetry/api'
import pino, { type Logger } from 'pino'

// One JSON object per line on stdout, in the shape Railway's Log Explorer
// parses: `message` and a string `level`; every other key becomes a filterable
// attribute (`@component:auth`, `@trace_id:…`).
export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    messageKey: 'message',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Tie each line to the request trace so a log line opens its trace.
    mixin() {
      const context = trace.getActiveSpan()?.spanContext()
      return context ? { trace_id: context.traceId, span_id: context.spanId } : {}
    },
    redact: {
      paths: [
        'password',
        'token',
        'secret',
        '*.password',
        '*.token',
        '*.secret',
        '*.authorization',
        '*.cookie',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  })
}

export const log = createLogger()
export type { Logger }
