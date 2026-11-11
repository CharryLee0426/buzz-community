import { z } from 'zod'
import { isPasswordHash } from './auth/password.js'

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value.replace(/\/+$/, '') : undefined))
  .pipe(z.url().optional())

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Railway's private network is reached over IPv6, so the default listens on
  // every address family.
  HOST: z.string().default('::'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  /** Where operators reach the community, e.g. https://buzz.chenli.dev. */
  PUBLIC_ORIGIN: z.url().transform((value) => new URL(value).origin),
  /** Directory holding the built web console. */
  STATIC_DIR: z.string().default('../web/dist'),

  ADMIN_USERNAME: z.string().trim().min(1),
  ADMIN_PASSWORD_HASH: z
    .string()
    .trim()
    .refine(isPasswordHash, 'must be the scrypt hash scripts/setup.mjs writes, never a plain password'),
  SESSION_SECRET: z.string().refine((value) => Buffer.byteLength(value) >= 32, 'must be at least 32 bytes'),
  SESSION_TTL_HOURS: z.coerce.number().min(0.25).max(24 * 7).default(12),

  /** Owner key of the community (hex or nsec). Signs member, invite and moderation changes. */
  CONSOLE_SECRET_KEY: optionalSecret,
  /** 32 random bytes, base64. Encrypts hosted-agent keys and invite links at rest. */
  CONSOLE_ENCRYPTION_KEY: optionalSecret,
  /** Shared secret the agent host presents on the private network. */
  HIVE_TOKEN: optionalSecret.refine((value) => !value || value.length >= 24, 'must be at least 24 characters'),

  /** The relay's Postgres. Community pages need it; the rest of the console does not. */
  DATABASE_URL: optionalSecret,

  RELAY_URL: optionalUrl,
  RELAY_HEALTH_URL: optionalUrl,
  RELAY_METRICS_URL: optionalUrl,

  /** Project token (or account token) used to read logs, metrics and deployments. */
  RAILWAY_API_TOKEN: optionalSecret,
  RAILWAY_PROJECT_ID: optionalSecret,
  RAILWAY_ENVIRONMENT_ID: optionalSecret,
  RAILWAY_ENVIRONMENT_NAME: optionalSecret,
  RAILWAY_SERVICE_ID: optionalSecret,
  RAILWAY_DEPLOYMENT_ID: optionalSecret,

  /** Path secret that authenticates Railway's project webhook deliveries. */
  WEBHOOK_TOKEN: optionalSecret.refine((value) => !value || value.length >= 24, 'must be at least 24 characters'),
  /** Optional Slack, Discord or Lark incoming-webhook URL that receives alerts. */
  ALERT_FORWARD_URL: optionalUrl,
})

export type Config = z.infer<typeof schema> & { isProduction: boolean; isSecureOrigin: boolean }

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/** Parses the environment once at startup and fails loudly, naming each bad variable but never its value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env)
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))
  }
  const config = result.data
  return {
    ...config,
    isProduction: config.NODE_ENV === 'production',
    isSecureOrigin: config.PUBLIC_ORIGIN.startsWith('https://'),
  }
}
