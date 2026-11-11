// The whole community as one Railway project. `railway config plan` previews
// and `railway config apply` reconciles the linked environment against this
// file; a resource removed here is deleted there.
//
// Settings come from ../community.config.json. Secrets are never written in
// this repository: scripts/setup.mjs generates them and passes them to the
// first apply through the environment; every later apply keeps the value
// Railway already holds.

import { readFileSync } from "node:fs";
import {
  bucket,
  defineRailway,
  github,
  group,
  image,
  postgres,
  preserve,
  project,
  redis,
  ref,
  service,
} from "railway/iac";

interface CommunityConfig {
  project: string;
  domain: string;
  region: string;
  bucketRegion: "sjc" | "iad" | "ams" | "sin";
  images: { relay: string; sprig: string };
  github: { repo: string | null; branch: string };
}

const config: CommunityConfig = JSON.parse(
  readFileSync(new URL("../community.config.json", import.meta.url), "utf8"),
);

/** A value the setup script supplies once; afterwards Railway's copy is kept. */
function provided(name: string, options: { sealed?: boolean } = {}) {
  const value = process.env[`BUZZ_SETUP_${name}`];
  if (value === undefined || value === "") return preserve();
  return options.sealed ? { value, isSealed: true } : value;
}
const secret = (name: string) => provided(name, { sealed: true });

export default defineRailway(() => {
  const { domain, region } = config;
  const origin = `https://${domain}`;
  const oneReplica = { [region]: 1 };
  // Railway configuration can manage a custom domain but not register one.
  // The setup script registers it with `railway domain` and leaves it out of
  // the applies that run before that.
  const domainIsRegistered = process.env.BUZZ_SETUP_DOMAIN_PENDING !== "1";

  // Services built from this repository deploy from GitHub when a repo is
  // configured, and from `railway up` otherwise.
  const fromRepo = (dockerfilePath: string, watchPatterns: string[]) => ({
    ...(config.github.repo ? { source: github(config.github.repo, { branch: config.github.branch }) } : {}),
    build: { builder: "DOCKERFILE" as const, dockerfilePath, watchPatterns },
  });

  // ── Data ────────────────────────────────────────────────────────────────
  const db = postgres("postgres", { region });
  const cache = redis("redis", { region });
  // One private bucket holds media and git objects. Its region is permanent.
  const media = bucket("media", { region: config.bucketRegion });

  // ── Community ───────────────────────────────────────────────────────────
  const relay = service("relay", {
    source: image(config.images.relay),
    replicas: oneReplica,
    // Railway probes the health check on $PORT. The relay ignores PORT and
    // serves /_readiness on its health listener, so PORT names that listener.
    healthcheck: "/_readiness",
    healthcheckTimeout: 300,
    tracing: { enabled: true },
    deploy: {
      restartPolicyType: "ALWAYS",
      // The relay drains sockets for up to 35 s after SIGTERM.
      drainingSeconds: 45,
    },
    env: {
      PORT: "8080",
      BUZZ_BIND_ADDR: "0.0.0.0:3000",
      BUZZ_HEALTH_PORT: "8080",
      BUZZ_METRICS_PORT: "9102",

      // The host of RELAY_URL is the community's identity: the relay binds
      // every request to it by Host header. Changing it starts an empty community.
      RELAY_URL: `wss://${domain}`,
      BUZZ_MEDIA_BASE_URL: `${origin}/media`,
      BUZZ_RELAY_PRIVATE_KEY: secret("RELAY_PRIVATE_KEY"),

      DATABASE_URL: db.env.DATABASE_URL,
      BUZZ_AUTO_MIGRATE: "true",
      // Railway Postgres allows 100 connections; leave room for the console.
      BUZZ_DB_POOL_SIZE: "20",
      REDIS_URL: cache.env.REDIS_URL,

      BUZZ_S3_ENDPOINT: ref(media, "ENDPOINT"),
      BUZZ_S3_BUCKET: ref(media, "BUCKET"),
      BUZZ_S3_REGION: ref(media, "REGION"),
      BUZZ_S3_ACCESS_KEY: ref(media, "ACCESS_KEY_ID"),
      BUZZ_S3_SECRET_KEY: ref(media, "SECRET_ACCESS_KEY"),
      BUZZ_S3_ADDRESSING_STYLE: "virtual",

      // Scratch space only; durable git state lives in the bucket.
      BUZZ_GIT_REPO_PATH: "/data/git",
      BUZZ_GIT_HOOK_HMAC_SECRET: secret("GIT_HOOK_HMAC_SECRET"),

      // Invite-only: only members connect, and their agents ride on the
      // owner's membership. REQUIRE_AUTH_TOKEN closes the unsigned X-Pubkey path.
      BUZZ_REQUIRE_RELAY_MEMBERSHIP: "true",
      BUZZ_REQUIRE_AUTH_TOKEN: "true",
      BUZZ_ALLOW_NIP_OA_AUTH: "true",
      RELAY_OWNER_PUBKEY: provided("RELAY_OWNER_PUBKEY"),
      BUZZ_CORS_ORIGINS: `${origin},tauri://localhost,http://tauri.localhost`,

      // The gateway overwrites this header with the caller's address.
      BUZZ_CLIENT_IP_HEADER: "x-buzz-client-ip",
      RUST_LOG:
        "buzz_relay=info,buzz_db=info,buzz_auth=info,buzz_pubsub=info,buzz_datastore=warn,tower_http=info",
    },
  });

  // Mobile pairing sidecar: same image, different binary. It speaks only
  // WebSocket, so it gets no HTTP health check. Its stderr is folded into
  // stdout so Railway does not mark every line as an error.
  const pairing = service("pairing", {
    source: image(config.images.relay),
    replicas: oneReplica,
    start: '/bin/sh -c "exec /usr/local/bin/buzz-pair-relay 2>&1"',
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      BUZZ_PAIR_RELAY_BIND_ADDR: "0.0.0.0:5000",
    },
  });

  // ── Edge ────────────────────────────────────────────────────────────────
  // The only public service: one hostname, routed by path.
  const gateway = service("gateway", {
    ...fromRepo("apps/gateway/Dockerfile", ["apps/gateway/**"]),
    replicas: oneReplica,
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    domains: domainIsRegistered ? [{ domain, port: 8080 }] : [],
    tracing: { enabled: true },
    deploy: {
      restartPolicyType: "ALWAYS",
      drainingSeconds: 30,
      overlapSeconds: 5,
    },
    env: {
      PORT: "8080",
      PUBLIC_HOST: domain,
      // Selects snippets/tracing-on.caddy: a gateway span on every request,
      // exported to the collector Railway provides, and a trace id the relay
      // and the console continue.
      GATEWAY_TRACING: "tracing-on",
      RELAY_UPSTREAM: "${{relay.RAILWAY_PRIVATE_DOMAIN}}:3000",
      PAIRING_UPSTREAM: "${{pairing.RAILWAY_PRIVATE_DOMAIN}}:5000",
      ADMIN_UPSTREAM: "${{admin.RAILWAY_PRIVATE_DOMAIN}}:8787",
    },
  });

  // ── Operations ──────────────────────────────────────────────────────────
  // Operator console, served under /admin by the gateway. It holds the
  // community owner key and signs member and invite changes with it.
  const admin = service("admin", {
    ...fromRepo("apps/admin/Dockerfile", ["apps/admin/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]),
    replicas: oneReplica,
    healthcheck: "/admin/healthz",
    healthcheckTimeout: 120,
    tracing: { enabled: true },
    deploy: {
      restartPolicyType: "ALWAYS",
      drainingSeconds: 20,
      overlapSeconds: 5,
    },
    env: {
      PORT: "8787",
      NODE_ENV: "production",
      PUBLIC_ORIGIN: origin,

      ADMIN_USERNAME: secret("ADMIN_USERNAME"),
      ADMIN_PASSWORD_HASH: secret("ADMIN_PASSWORD_HASH"),
      SESSION_SECRET: secret("SESSION_SECRET"),
      // Owner key of the community (hex). Its public half is RELAY_OWNER_PUBKEY.
      CONSOLE_SECRET_KEY: secret("CONSOLE_SECRET_KEY"),
      // Encrypts hosted-agent keys and invite links at rest.
      CONSOLE_ENCRYPTION_KEY: secret("CONSOLE_ENCRYPTION_KEY"),
      HIVE_TOKEN: secret("HIVE_TOKEN"),
      WEBHOOK_TOKEN: secret("WEBHOOK_TOKEN"),
      // Read access to this project's logs, metrics and deployments.
      RAILWAY_API_TOKEN: secret("RAILWAY_API_TOKEN"),
      // Optional: a Slack, Discord or Feishu incoming webhook that also gets critical and warning alerts.
      ALERT_FORWARD_URL: secret("ALERT_FORWARD_URL"),

      DATABASE_URL: db.env.DATABASE_URL,
      RELAY_URL: "http://${{relay.RAILWAY_PRIVATE_DOMAIN}}:3000",
      RELAY_HEALTH_URL: "http://${{relay.RAILWAY_PRIVATE_DOMAIN}}:8080",
      RELAY_METRICS_URL: "http://${{relay.RAILWAY_PRIVATE_DOMAIN}}:9102/metrics",

      // Railway's collector takes traces only.
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,pg,undici",
    },
  });

  // ── Agents ──────────────────────────────────────────────────────────────
  // Runs every community-hosted agent: one buzz-acp process per agent, each
  // under its own system user. Model credentials stay in this service and
  // reach providers through its local proxy, never through an agent's shell.
  const hive = service("hive", {
    ...fromRepo("apps/hive/Dockerfile", ["apps/hive/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]),
    replicas: oneReplica,
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: {
      restartPolicyType: "ALWAYS",
      // buzz-acp finishes in-flight turns for up to 60 s on SIGTERM.
      drainingSeconds: 75,
    },
    env: {
      PORT: "8790",
      SPRIG_IMAGE: config.images.sprig,
      // Agents reach the relay by its public name: the relay binds a
      // connection to the community by that hostname.
      BUZZ_RELAY_URL: `wss://${domain}`,
      ADMIN_URL: "http://${{admin.RAILWAY_PRIVATE_DOMAIN}}:8787",
      HIVE_TOKEN: admin.env.HIVE_TOKEN,

      ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
      OPENAI_API_KEY: secret("OPENAI_API_KEY"),
      // Any endpoint that speaks OpenAI's API; unset means api.openai.com.
      OPENAI_BASE_URL: provided("OPENAI_BASE_URL"),
      OPENROUTER_API_KEY: secret("OPENROUTER_API_KEY"),
    },
  });

  return project(config.project, {
    resources: [
      group("Edge", [gateway]),
      group("Community", [relay, pairing]),
      group("Data", [db, cache, media]),
      group("Operations", [admin]),
      group("Agents", [hive]),
    ],
  });
});
