# Operations and observability

## What Railway gives you, and how this project uses it

| Signal | Where it comes from | Where to look |
|---|---|---|
| Logs | Every service writes one JSON object per line with `level` and `message` at the top. Railway indexes the rest as searchable fields. | Railway → Observability → Logs; `railway logs --service <name>`; the console's Logs page |
| Traces | Tracing is enabled on `gateway`, `relay` and `admin`. The gateway starts a trace for each request and the relay and console continue it. | Railway → Observability → Traces |
| HTTP metrics | Railway measures requests, status codes and latency on the gateway, the one service with a domain. | Railway → the gateway service → Metrics; the console's Metrics page |
| Resource metrics | CPU, memory, network and volume usage for every service. | Railway → each service → Metrics; the console's Services and Metrics pages |
| Relay metrics | Railway does not scrape Prometheus endpoints, so the console samples the relay's once a minute and keeps connections, subscriptions, events stored and events refused. | The console's Overview and Metrics pages |
| Deploy events | Railway posts crashes, failed deployments and usage alerts to the console's webhook. | The console's Alerts page; optionally a chat channel |

### Following one request

Every log line a request produces carries the same trace id: `traceID` in the gateway's access log, `trace_id` in the console's and the relay's. To see what one request did in each service:

```sh
railway logs --service gateway --filter '@traceID:8e0a51e1cf975cfb206cb126f973bd47'
railway logs --service admin   --filter '@trace_id:8e0a51e1cf975cfb206cb126f973bd47'
railway logs --service relay   --filter '@trace_id:8e0a51e1cf975cfb206cb126f973bd47'
```

Responses from the gateway also carry `x-railway-trace-id`, Railway's own id for the edge request.

### Useful log filters

`@name:value` matches a field of a structured line; bare words search the message only, not the fields.

```sh
railway logs --service relay --filter '@level:error'
railway logs --service admin --filter '@component:alerts'
railway logs --service admin --filter '@status:401'
railway logs --service hive  --filter '@agent_id:<id from the console>'
railway logs --service gateway --http --filter '@httpStatus:>=500'    # Railway's edge log of requests
```

Agent processes log through the agent host, which keeps each line's level and adds `agent` and `agent_id`.

### What is deliberately not logged

- Request and response bodies, anywhere.
- Request headers at the gateway, which would include session cookies and signed authorizations.
- Invite codes: the gateway masks them in paths.
- Model requests: the agent host logs that a request happened, for which agent, and its status and duration.
- The console's own polling from the agent host, unless it fails.

## Health

- Railway checks a health endpoint when it deploys a service and switches traffic only after it answers: `/healthz` on the gateway and agent host, `/admin/healthz` on the console, `/_readiness` on the relay. It does not keep checking after that.
- Every service restarts when it exits (`restartPolicyType: ALWAYS`).
- On a deploy the old instance gets time to finish: 45 seconds for the relay, 75 for the agent host, 30 for the gateway.
- `node scripts/verify.mjs` checks the whole path from outside at any time. Run it from a scheduler if you want continuous checking; Railway does not provide it.

## Alerts

Set up once, by hand (`AGENTS.md`, step 8): paste the console's webhook address into Railway's project webhooks. Then:

- A crashed or failed deployment arrives as a **critical** alert.
- Usage and threshold alerts arrive as **warnings**.
- Other deployment events are recorded as informational and need no acknowledgement.

Railway's monitors (alert when CPU, memory or disk crosses a threshold) are configured in its dashboard: Observability → a widget → *Add monitor*. Worth setting: Postgres volume above 80%, relay memory above 80% of its limit.

Set a usage limit for the workspace in Railway's billing settings so a runaway service cannot run up a bill unnoticed.

## Backups and recovery

| What | How it is protected | How to restore |
|---|---|---|
| Messages, members, channels | Postgres. Turn on point-in-time recovery: `railway postgres pitr --help`. | Railway restores to a moment you choose. |
| Media and git objects | The bucket. | No action needed for hardware failure; deleted objects are not recoverable. |
| Relay key, owner key, other generated secrets | Railway's sealed variables, and the `.secrets/` file from setup. | Set the variable again from the backup. |
| Everything else | This repository. | `node scripts/setup.mjs && node scripts/deploy.mjs` |

Redis holds nothing that needs restoring.

## Upgrading

1. Read the upstream release notes for `block/buzz`.
2. Change `images.relay` (and `images.sprig`, to the same release) in `community.config.json`.
3. `node scripts/setup.mjs --plan`, read it, then `node scripts/setup.mjs`.
4. `node scripts/verify.mjs`.

The relay migrates its database when it starts and has no downgrade path, so take a backup first. To go back to the previous image afterwards you would also need to restore the database.

## Costs to watch

Railway bills for what runs. The relay, Postgres and the agent host are the parts whose usage grows with the community; the gateway, console, pairing relay and Redis stay small. Network egress is billed, which is where media downloads show up.
