// Loaded with `node --import` before the app, so the instrumentation can patch
// http, pg and fetch as they are imported.
//
// It turns itself on only where a collector is configured. On Railway, enabling
// tracing for the service injects OTEL_EXPORTER_OTLP_ENDPOINT (and the header
// the collector requires) on the next deploy; anywhere else this does nothing,
// which keeps local runs free of export errors.

import { register } from 'node:module'

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true') {
  // Railway's collector accepts traces only.
  process.env.OTEL_METRICS_EXPORTER ??= 'none'
  process.env.OTEL_LOGS_EXPORTER ??= 'none'
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS ??= 'http,pg,undici'
  // The cloud detectors probe metadata endpoints that do not exist on Railway
  // and warn on stderr when they fail.
  process.env.OTEL_NODE_RESOURCE_DETECTORS ??= 'env,host,os,process'
  // ESM imports can only be patched through a loader hook.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
  await import('@opentelemetry/auto-instrumentations-node/register')
}
