# Buzz community

A self-hosted community for [Buzz](https://github.com/block/buzz-app), the team chat where people and AI agents share channels. This repository runs the whole thing on [Railway](https://railway.com) behind one domain:

- **The relay** that the Buzz 1.0 desktop app connects to, invite-only, with Postgres, Redis and object storage.
- **An operator console** at `/admin`: members and invites, channels, hosted agents, and the logs, metrics, alerts and deployments of the services underneath.
- **An agent host**, for agents that should stay online for their owner or that several members share.
- **Observability set up from the start**: structured logs, traces that follow a request from the edge into the relay, health checks, and alerts for crashes and failed deployments.

Everything Railway runs is declared in code (`.railway/railway.ts`), and no secret is stored in this repository.

## Set one up

You need Node 24, the Railway CLI, a Railway account on a paid plan, and a domain.

```sh
pnpm install
# edit community.config.json: project name, domain, region; set github.repo to null
railway login && railway init --name <project>
BUZZ_ADMIN_USERNAME=<you> BUZZ_ADMIN_PASSWORD=<12+ characters> node scripts/setup.mjs
node scripts/deploy.mjs
node scripts/dns.mjs        # add the two records it prints at your DNS provider
node scripts/verify.mjs     # every line should pass
```

Then sign in at `https://<your domain>/admin`, create an invite, and paste it into Buzz under *Join a community*.

**[AGENTS.md](AGENTS.md) is the full guide**, written so a coding agent can do the setup for you: every step, how to check it, what to do when it fails, and which parts need you. Point your agent at it, or follow it yourself.

## Where agents run

| The agent answers | It can run |
|---|---|
| One member | in that member's Buzz app, or hosted here |
| Several members, or everyone | hosted here |

A member's own agent needs nothing from the community. Hosting covers what the app cannot: an agent that outlives a closed laptop, and an agent more than one person uses. [docs/agents.md](docs/agents.md) explains how each kind is vouched for and isolated.

## Layout

| Path | |
|---|---|
| [`community.config.json`](community.config.json) | The few settings that differ between communities. |
| [`.railway/railway.ts`](.railway/railway.ts) | The Railway project as code. |
| [`scripts/`](scripts) | `setup`, `deploy`, `dns`, `verify`. |
| [`apps/gateway`](apps/gateway) | Caddy: the one public entry point. |
| [`apps/admin`](apps/admin) | The console: a Hono API and a React app built with the [Astryx](https://astryx.atmeta.com) design system. |
| [`apps/hive`](apps/hive) | The agent host. |
| [`docs/`](docs) | [Architecture](docs/architecture.md), [operations and observability](docs/operations.md), [agents](docs/agents.md), [security](docs/security.md). |

## Upstream

The relay and the agent runtime are [block/buzz](https://github.com/block/buzz), used unmodified from the images pinned in `community.config.json`. The desktop app is [block/buzz-app](https://github.com/block/buzz-app). This repository is the deployment around them and is not affiliated with Block.

## License

[Apache-2.0](LICENSE).
