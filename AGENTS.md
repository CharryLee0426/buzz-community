# Setting up and operating this Buzz community

This file is for a coding agent (or a person) who has cloned this repository and wants a working Buzz community: a relay that the Buzz 1.0 desktop app connects to, an operator console, hosted agents, and Railway observability, all on one Railway project behind one domain.

Follow the steps in order. Each step says what it changes, how to check it, and what to do when the check fails. Stop and ask the person you are working for wherever a step is marked **Needs a person**.

## What you are building

```
                    https://<domain>            wss://<domain>
                           │                          │
                     ┌─────▼──────────────────────────▼─────┐
                     │ gateway  (Caddy, the only public service) │
                     └──┬───────────┬───────────────┬───────┘
              /admin/*  │     /pair │     everything else
                  ┌─────▼──┐   ┌────▼────┐   ┌──────▼─────┐
                  │ admin  │   │ pairing │   │   relay    │  ghcr.io/block/buzz
                  │console │   │  relay  │   │            │
                  └─┬────┬─┘   └─────────┘   └─┬───┬────┬─┘
        desired set │    │ read-only           │   │    │
        and status  │    └────────────┐        │   │    │
                  ┌─▼────┐         ┌──▼────────▼┐ ┌▼───┐┌▼──────┐
                  │ hive │         │  postgres  │ │redis││ media │ bucket
                  │agents│         └────────────┘ └────┘└───────┘
                  └──┬───┘
                     └── each agent connects back in through wss://<domain>
```

| Path | What it is |
|---|---|
| `community.config.json` | The only file you edit for a new community: project name, domain, regions, image versions. No secrets. |
| `.railway/railway.ts` | The whole Railway project as code. `railway config apply` makes Railway match it. |
| `scripts/setup.mjs` | Generates secrets, applies the configuration, attaches the domain. Safe to run again. |
| `scripts/deploy.mjs` | Builds and deploys the three services whose code is here: `gateway`, `admin`, `hive`. |
| `scripts/dns.mjs` | Prints the DNS records Railway needs and their status; `--apply` writes them to Cloudflare. |
| `scripts/verify.mjs` | Checks the deployed community from the outside. Read-only. |
| `apps/gateway` | Caddy configuration: routing, access logs, what is blocked from the internet. |
| `apps/admin/server`, `apps/admin/web` | The operator console: API (Hono, Node) and web app (React, Astryx design system). |
| `apps/hive` | The agent host: supervises one upstream `buzz-acp` process per hosted agent. |
| `docs/` | Architecture, operations and observability, agents, security. |

## Rules that are easy to break

1. **Never commit or print a secret.** Secrets exist in two places only: Railway's sealed variables, and `.secrets/<project>.<environment>.json` on the machine that ran setup (git-ignored, mode 0600). Do not `cat` that file into a transcript, a log, an issue, or a commit. The repository is meant to be public.
2. **The domain is the community's identity.** The relay keys every member, channel and message to the hostname in `domain`. Changing it after launch does not rename the community; it starts a second, empty one. Decide the domain before step 3.
3. **Regions are permanent once applied.** Moving `region` relocates the databases (Railway treats it as destructive) and `bucketRegion` cannot change at all. Decide them before step 3.
4. **`railway config apply` deletes what the file no longer declares.** Run `node scripts/setup.mjs --plan` and read the plan before applying a change to `.railway/railway.ts`. Do not apply a plan that destroys `postgres`, `redis` or `media`.
5. **One relay replica.** The relay keeps live subscriptions in memory; this configuration is not set up for more than one.
6. **Do not create accounts, tokens, webhooks or DNS records on someone's behalf without their say-so.** The steps below mark each of these.

## Prerequisites

Check each one; install what is missing.

```sh
node --version      # v24 or newer
corepack enable     # provides pnpm 11, the version pinned in package.json
railway --version   # 5.63.0 or newer; `brew install railway` or `npm i -g @railway/cli`
```

- A Railway account on a paid plan. The project has seven services, a bucket and two databases; the trial plan's limits are too low.
- A domain name whose DNS you can edit. A subdomain is fine (`buzz.example.com`).
- Optional: Docker, to build the images locally before deploying. `gh`, if the repository should live on GitHub.

Then install dependencies:

```sh
pnpm install
```

## Step 1. Describe the community

Edit `community.config.json`:

| Field | Set it to |
|---|---|
| `project` | The Railway project name. |
| `domain` | The hostname members and operators will use. See rule 2. |
| `region` | The Railway region for the services and databases. `sfo` (US West) is what this repository is deployed and tested with. See rule 3. |
| `bucketRegion` | `sjc`, `iad`, `ams` or `sin`: the storage region closest to `region`. See rule 3. |
| `images.relay`, `images.sprig` | Leave as they are. They pin the upstream relay and agent images that this repository was tested against. |
| `github.repo` | Set it to `null`. A fresh clone still names the repository it was cloned from, which your Railway account cannot deploy. Step 8 covers pointing it at your own copy. |

## Step 2. Sign in to Railway and create the project

**Needs a person:** `railway login` opens a browser. Ask them to run it, and to say which workspace the project belongs in if they have more than one.

```sh
railway login
railway init --name <project> --workspace "<workspace name>"   # new community
# or, to take over an existing project:  railway link
```

Check: `railway status` prints the project name.

## Step 3. Generate secrets and apply the configuration

**Needs a person:** the console's username and password (at least 12 characters). Ask for them; do not invent a password and do not write it to any file.

```sh
BUZZ_ADMIN_USERNAME='<username>' BUZZ_ADMIN_PASSWORD='<password>' node scripts/setup.mjs
```

What this does, in order:

1. Checks the CLI version, the login and the linked project.
2. Generates what Railway does not hold yet: the relay's key, the console's owner key, the session, encryption, agent-host and webhook secrets. The password is stored only as a scrypt hash.
3. Writes a backup of the generated values to `.secrets/<project>.<environment>.json`. **Tell the person to move that file into a password manager.** The relay key and the owner key cannot be regenerated without orphaning the community.
4. Runs `railway config apply`: creates Postgres, Redis, the bucket and the seven services, with every secret as a sealed variable.
5. Attaches `domain` to the gateway and creates a Railway-generated hostname for testing before DNS exists.

Check: the script ends with "Next steps". `railway service list` shows `relay`, `pairing`, `postgres` and `redis` reaching `SUCCESS` within a few minutes; `gateway`, `admin` and `hive` have nothing deployed yet.

If it fails:

| Message | Cause and fix |
|---|---|
| `requires Railway CLI 5.42.1 or newer` although the CLI is current | The configuration SDK read the wrong program from the shell's `_` variable. Run the script with `env -u _ node scripts/setup.mjs`. |
| `out of step: one exists on Railway and the other does not` | The console's owner key and the relay's record of it have diverged. Restore the missing variable from the secrets backup. Do not delete the other one: a new key would lock the console out of its own community. |
| A plan line that moves or destroys `postgres`, `redis` or `media` | `region` or `bucketRegion` no longer matches what was first applied. Put the original value back. |
| `Custom-domain registration is not supported by Railway configuration` | The domain was added to the configuration before it was attached. Run the setup script; it does both in the right order. |

To change the console password later, run the same command with a new `BUZZ_ADMIN_PASSWORD`. To preview any change without making it: `node scripts/setup.mjs --plan`.

## Step 4. Deploy the services built from this repository

```sh
node scripts/deploy.mjs
```

It deploys `gateway`, `admin` and `hive` one after another and streams each build. Expect 2 to 4 minutes per service.

Check: `railway service list` shows all seven services as `SUCCESS`. The Railway-generated hostname from step 3 now answers:

```sh
node scripts/verify.mjs --host <generated-hostname>.up.railway.app
```

The relay-identity checks fail on that hostname, which is expected: the relay only answers for `domain`. The gateway and console checks should pass.

If a build fails: `railway logs --service <name> --build`. If a service builds and then fails its health check: `railway logs --service <name>`; the first error line usually names a missing variable.

## Step 5. Point DNS at Railway

```sh
node scripts/dns.mjs
```

It prints two records: a `CNAME` that routes traffic and a `TXT` that proves ownership.

**Needs a person**, one of:

- They add the two records at their DNS provider. On Cloudflare the `CNAME` must be **DNS only** (grey cloud), not proxied: clients hold long-lived WebSocket connections and Railway issues the certificate itself.
- Or they supply a Cloudflare API token limited to *Zone → DNS → Edit* on that zone, and you run `CLOUDFLARE_API_TOKEN=<token> node scripts/dns.mjs --apply`.

Check: run `node scripts/dns.mjs` again until both records show `✓` and the certificate is `valid`. This usually takes 2 to 10 minutes.

## Step 6. Verify

```sh
node scripts/verify.mjs
```

Every line should be `✓`: the gateway is up, the relay's private endpoints return 404 from outside, the relay advertises NIP-42 and NIP-43 and challenges a WebSocket to authenticate, the pairing relay accepts connections, the console serves its app with security headers and refuses unauthenticated API calls, every Railway deployment succeeded, and the certificate is valid.

Do not report the community as working until this passes.

## Step 7. First sign-in

**Needs a person.** They open `https://<domain>/admin` and sign in. Then:

1. **Members → Invite people** creates an invite link. In the Buzz app: *Join a community*, paste the link.
2. **Settings** lists what the console is connected to and what is still missing, with the fix for each.

The community is invite-only. Nobody can connect without an invite or being added by public key.

## Step 8. Finish the integrations

Each of these is optional and independent. Settings in the console shows which are done.

### Logs, metrics and deployments inside the console

**Needs a person:** in Railway, *Project Settings → Tokens*, create a project token for the production environment. Then:

```sh
BUZZ_RAILWAY_API_TOKEN='<token>' node scripts/setup.mjs
```

Without it the console's Services, Logs, Metrics and Deployments pages say that Railway is not connected; everything else works. Railway's own dashboard has the same data either way.

### Alerts for crashes and failed deployments

**Needs a person:** copy *Webhook address for Railway* from the console's Settings page and paste it into Railway under *Project Settings → Webhooks*. Railway then posts deployment failures, crashes and usage alerts to the console's Alerts page. The address contains a secret; treat it like a password.

To repeat critical and warning alerts into a chat channel as well:

```sh
BUZZ_ALERT_FORWARD_URL='<Slack, Discord or Feishu incoming-webhook URL>' node scripts/setup.mjs
```

### Model keys for hosted agents

**Needs a person:** an API key for at least one provider.

```sh
ANTHROPIC_API_KEY='<key>' node scripts/setup.mjs      # or OPENAI_API_KEY, OPENROUTER_API_KEY
```

The key is stored sealed on the `hive` service. Agents never see it: see `docs/agents.md`.

### Deploy from GitHub on every push

1. Push the repository to GitHub.
2. **Needs a person:** install the Railway GitHub app on that repository (Railway prompts for this the first time a service is connected to it).
3. Set `github.repo` in `community.config.json` to `owner/name`, then `node scripts/setup.mjs --plan`, read it, and `node scripts/setup.mjs`.

From then on a push to `github.branch` rebuilds whichever of `gateway`, `admin`, `hive` it touched.

### Backups

Postgres holds every message. Turn on continuous backup once the community has real data:

```sh
railway postgres pitr --help
```

**Needs a person** to agree to the cost before you enable it. Media and git objects live in the bucket, which Railway stores redundantly. The relay key and owner key are backed up by the file from step 3 and nowhere else.

## Operating it afterwards

| Task | How |
|---|---|
| See what is running | `railway service list`, or the console's Overview |
| Read logs | `railway logs --service <name>`; add `--filter '@level:error'` to narrow. Every line is structured JSON, and the gateway, the console and the relay log the same trace id for one request. `docs/operations.md` has the filters. |
| Deploy a change to this repository's code | `node scripts/deploy.mjs <service>`, or push if step 8's GitHub deploys are on |
| Change Railway configuration | Edit `.railway/railway.ts`, then `node scripts/setup.mjs --plan`, then `node scripts/setup.mjs` |
| Roll back a service | Railway dashboard → the service → Deployments → *Rollback* on the last good one |
| Upgrade the relay or agent image | Change `images.relay` / `images.sprig` in `community.config.json` to a newer upstream tag, plan, apply, then `node scripts/verify.mjs`. Read upstream's release notes first; the relay migrates its own database on start and does not migrate back. |
| Change the console password | Step 3's command with a new `BUZZ_ADMIN_PASSWORD` |
| Host an agent | Console → Agents → *Host an agent*. `docs/agents.md` explains who can use which kind. |
| Remove or ban someone | Console → Members |

## Working on the code

```sh
pnpm typecheck && pnpm test && pnpm lint && pnpm build     # everything
pnpm --filter @buzz-community/admin-web dev               # console UI on http://127.0.0.1:5173/admin/
pnpm --filter @buzz-community/admin-server dev            # console API on :8787, reads apps/admin/server/.env
```

- The UI talks to a console server on `127.0.0.1:8787` by default. `apps/admin/server/.env.example` lists what that server needs.
- `apps/admin/web/AGENTS.md` holds the rules for the Astryx design system. Read it before changing any page: pages start from Astryx components and tokens, with no raw layout elements and no hard-coded colors. Run `pnpm exec astryx doctor --built .` in that directory before you finish.
- The console never talks to the relay's database with write access. It reads through a read-only connection and changes membership only by sending the relay signed commands, the same ones an admin's Buzz app sends.
- Comments in this codebase say why something is the way it is. Keep them true when you change the code under them.

## What has and has not been verified

Verified against the live deployment this repository came from: the full setup path above, relay admission and membership changes from the console, invite creation and revocation, the agent host starting an upstream agent process that authenticates to the relay and publishes its profile, trace propagation from the gateway to the console, and every check in `scripts/verify.mjs`.

Not verified, so test before relying on it:

- **A complete agent conversation.** No model key was available, so no hosted agent has answered a message end to end. Upstream also states that Buzz 1.0 and its headless agent runner are compatible at the wire level without an end-to-end test of their own.
- **`scripts/dns.mjs --apply`.** The records for the reference deployment were added by hand; the Cloudflare API path is written to Cloudflare's v4 API and has not run against a live zone.
- **The console's Railway-backed pages** (Services, Logs, Metrics, Deployments) against real data, because they need the project token from step 8.
