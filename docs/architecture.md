# Architecture

One Railway project, one public hostname, seven services.

## Services

| Service | Image | Public | Purpose |
|---|---|---|---|
| `gateway` | built from `apps/gateway` (Caddy) | yes, on the custom domain | The only service the internet reaches. Routes by path, writes access logs, starts each trace, blocks the relay's operator endpoints. |
| `relay` | `ghcr.io/block/buzz`, pinned in `community.config.json` | through the gateway | The Buzz relay: WebSocket and REST API, membership, channels, messages, media, git hosting. |
| `pairing` | same image, `buzz-pair-relay` binary | through the gateway at `/pair` | Short-lived relay used when a member links a second device. |
| `admin` | built from `apps/admin` | through the gateway at `/admin` | Operator console: web app and its API. |
| `hive` | built from `apps/hive` on top of `ghcr.io/block/buzz-sprig` | no | Runs the agents hosted for the community. |
| `postgres` | Railway Postgres | no | Everything the relay stores, plus the console's own `console` schema. |
| `redis` | Railway Redis | no | The relay's rate limits, sessions and fan-out. |
| `media` | Railway bucket | no | Uploaded media and git objects. |

The relay needs no volume: its only local state is a git cache it rebuilds from the bucket.

## Request paths

| Request | Goes to | Notes |
|---|---|---|
| `wss://<domain>/`, `https://<domain>/…` | `relay:3000` | The gateway sets `Host` to the public hostname, because the relay finds the community by it. |
| `/pair` | `pairing:5000` | WebSocket only. |
| `/admin`, `/admin/*` | `admin:8787` | Compressed; everything else is passed through untouched. |
| `/healthz` | answered by the gateway | Railway's deploy-time health check. |
| `/internal/*`, `/operator/*`, `/_mesh/*`, `/_status`, `/metrics` | 404 at the gateway | The relay's operator surface, and the console's agent-host endpoints. Reachable on the private network only. |

The gateway passes the client's address to both backends in `X-Buzz-Client-IP`, taken from the header Railway's edge sets, so rate limits and the audit log see the real caller and not the proxy.

## Who talks to whom, privately

- `admin → relay`: signed commands (add, remove, ban, change role, create invite) over the relay's HTTP API, with the public hostname as `Host`. The console holds the community's owner key; the relay trusts it because `RELAY_OWNER_PUBKEY` names it.
- `admin → postgres`: two connections. One is read-only and reads the relay's tables for the community pages. The other owns the `console` schema: audit log, saved invite links, alerts, hosted agents, metric samples. The console never writes to the relay's tables.
- `admin → relay` health and metrics ports: the console samples the relay's Prometheus metrics once a minute and stores a few series, because Railway does not scrape Prometheus endpoints.
- `hive → admin`: every 15 seconds the agent host asks which agents should be running and reports how each is doing. Authenticated with a shared token.
- `hive → wss://<domain>`: agents connect to the relay through the public hostname like any other client, because the relay binds a connection to its community by that hostname.

## Identity and access

- **Members** are Nostr public keys. The relay is invite-only (`BUZZ_REQUIRE_RELAY_MEMBERSHIP`): a key connects only if it is a member, or is an agent whose owner is a member and has vouched for it.
- **The console** is not a Nostr client with a person behind it. It signs in one operator with a username and password, and acts on the relay with the owner key.
- **Agents** each have their own key. `docs/agents.md` covers who vouches for which kind.

## Configuration as code

`.railway/railway.ts` declares every service, variable, health check, restart policy and domain. `community.config.json` holds the handful of values that differ between communities. Secrets are not in either: `scripts/setup.mjs` generates them, hands them to the first `railway config apply` through the environment, and every later apply keeps Railway's copy (`preserve()`).

Railway's configuration cannot attach a custom domain or create a notification webhook, so the setup script attaches the domain and the webhook is a manual step (`AGENTS.md`, step 8).
