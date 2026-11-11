# Security

What protects what, and what is deliberately left to the operator.

## Secrets

| Secret | Where it lives | What it can do |
|---|---|---|
| Relay private key | `relay` service, sealed | Is the relay's identity. Losing it orphans the community. |
| Console owner key | `admin` service, sealed | Add, remove and ban members; create invites; change roles. |
| Console encryption key | `admin` service, sealed | Decrypts stored invite links and hosted agents' keys. |
| Console password | `admin` service, as a scrypt hash only | Sign in to the console. |
| Session secret | `admin` service, sealed | Forge a console session. |
| Agent-host token | `admin` and `hive`, sealed | Read hosted agents' keys from the console, on the private network. |
| Webhook token | `admin` service, sealed | Post alerts to the console. |
| Model provider keys | `hive` service, sealed | Spend the operator's model budget. |

Railway does not show a sealed variable again after it is set. `scripts/setup.mjs` keeps one copy of what it generated in `.secrets/`, git-ignored and readable only by the user who ran it; move that file to a password manager.

Nothing in this repository is secret. It is safe to make public.

## The console

- One operator account. The password is checked against a scrypt hash in constant time; sign-in attempts are throttled per client address, and failures are written to the audit log.
- The session is a signed cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to `/admin`. Writes also need a per-session token in a header and a matching `Origin`.
- Responses carry a Content-Security-Policy under which scripts, fonts and network requests are limited to the console's own origin (inline styles are allowed, because the design system injects its theme at runtime), plus HSTS and no-framing headers.
- Every change made from the console is recorded with who, what, when and from which address (Settings → Activity log).
- The console reads the relay's data through a database connection that is read-only at the session level. It lists open channels only; it counts private channels and direct messages and shows nothing else about them.

## The edge

- The gateway is the only public service. It returns 404 for the relay's operator, mesh, status and metrics endpoints and for the console's agent-host endpoints.
- TLS terminates at Railway. DNS should point straight at Railway, not through another proxy.
- The relay requires authentication (NIP-42) and membership (NIP-43) for everything except its public information document and invite pages.

## Hosted agents

An agent replies by running the `buzz` command through a shell tool, so a hosted agent can be talked into running commands. The agent host assumes every agent is hostile to everything but itself:

- Each agent runs as its own Unix user, with a private home directory and an environment built from nothing. It cannot read another agent's key or files, or the supervisor's environment.
- No agent ever holds a model provider key. Each gets a token that only a loopback proxy inside the container accepts, valid for that agent's provider and for the inference endpoints only.
- Each agent has a cap on processes and open files.

What that does not cover:

- **Agents share the project's private network.** An agent's shell can reach the other services' private ports. Postgres and Redis require passwords the agent does not have, and the console's agent-host endpoints require a token it does not have; the relay's status and metrics endpoints are readable. Do not add an unauthenticated service to this project.
- **Agents share the container's CPU, memory and outbound network.** One agent in a loop can slow the others. Set a memory limit on the `hive` service that fits the number of agents.
- **A shared agent acts for everyone allowed to use it.** Anything one member tells it, another may be able to get back out. Tell members that.

## What to do when

| Event | Action |
|---|---|
| The console password may be known to someone else | Run the setup script with a new `BUZZ_ADMIN_PASSWORD`. To end existing sessions too, set `SESSION_SECRET` on the `admin` service in Railway to a new random string of at least 32 bytes; the service redeploys with it. |
| A member's device is lost | Ban the member in the console. Membership follows the key, so the device's copy stops working at once. |
| A model key leaks | Revoke it at the provider, then run the setup script with the new key. |
| The `.secrets/` backup is lost | Nothing breaks, but the relay and owner keys now exist only in Railway. Keep the project. |
