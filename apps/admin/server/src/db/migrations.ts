import type pg from 'pg'
import type { Logger } from '../log.js'

// Forward-only migrations for the `console` schema. They never touch the
// relay's tables. Applied at startup under an advisory lock, so two instances
// starting together during a deploy cannot race.

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'console state',
    sql: `
      create table invites (
        id          uuid primary key default gen_random_uuid(),
        -- sha256 of the invite code; matches relay_invites.token_hash
        token_hash  bytea not null unique check (length(token_hash) = 32),
        link_sealed text not null,
        note        text not null default '',
        created_by  text not null,
        created_at  timestamptz not null default now()
      );

      create table audit_log (
        id        bigint generated always as identity primary key,
        at        timestamptz not null default now(),
        actor     text not null,
        action    text not null,
        target    text,
        detail    jsonb not null default '{}',
        client_ip text
      );
      create index audit_log_at_idx on audit_log (at desc);

      create table alerts (
        id              bigint generated always as identity primary key,
        received_at     timestamptz not null default now(),
        source          text not null,
        type            text not null,
        severity        text not null check (severity in ('critical', 'warning', 'notice', 'info')),
        service         text,
        environment     text,
        summary         text not null,
        payload         jsonb not null default '{}',
        acknowledged_at timestamptz,
        acknowledged_by text
      );
      create index alerts_received_at_idx on alerts (received_at desc);
      create index alerts_open_idx on alerts (received_at desc) where acknowledged_at is null;

      create table agents (
        id                      uuid primary key default gen_random_uuid(),
        name                    text not null check (length(name) between 1 and 64),
        about                   text not null default '',
        pubkey                  text not null unique check (pubkey ~ '^[0-9a-f]{64}$'),
        secret_sealed           text not null,
        -- 'member': a personal agent, attested by the member who owns it.
        -- 'community': owned by a custodian key the console holds for it alone.
        owner_kind              text not null check (owner_kind in ('member', 'community')),
        owner_pubkey            text not null check (owner_pubkey ~ '^[0-9a-f]{64}$'),
        custodian_secret_sealed text,
        auth_tag                jsonb,
        access                  text not null check (access in ('owner', 'allowlist', 'anyone')),
        allowlist               text[] not null default '{}',
        provider                text not null check (provider in ('anthropic', 'openai', 'openrouter')),
        model                   text not null,
        instructions            text not null default '',
        desired_state           text not null default 'running' check (desired_state in ('running', 'stopped')),
        created_by              text not null,
        created_at              timestamptz not null default now(),
        updated_at              timestamptz not null default now(),
        -- The hosting rule, enforced where it cannot be bypassed: an agent that
        -- answers more than its owner is owned by the community, and a member's
        -- personal agent answers that member only.
        constraint agents_hosting_rule check (
          (owner_kind = 'member' and access = 'owner')
          or (owner_kind = 'community' and access in ('allowlist', 'anyone'))
        ),
        constraint agents_allowlist_rule check (
          (access = 'allowlist' and cardinality(allowlist) between 1 and 200)
          or (access <> 'allowlist' and cardinality(allowlist) = 0)
        ),
        constraint agents_custodian_rule check ((owner_kind = 'community') = (custodian_secret_sealed is not null))
      );

      create table agent_status (
        agent_id    uuid primary key references agents (id) on delete cascade,
        reported_at timestamptz not null default now(),
        state       text not null,
        detail      jsonb not null default '{}'
      );

      create table metric_samples (
        name  text not null,
        at    timestamptz not null,
        value double precision not null,
        primary key (name, at)
      );
    `,
  },
]

export async function migrate(pool: pg.Pool, log: Logger): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['buzz-console-migrations'])
    await client.query('create schema if not exists console')
    await client.query(`
      create table if not exists console.schema_migrations (
        version    int primary key,
        name       text not null,
        applied_at timestamptz not null default now()
      )`)
    const { rows } = await client.query<{ version: number }>('select version from console.schema_migrations')
    const applied = new Set(rows.map((row) => row.version))

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await client.query('begin')
      try {
        await client.query('set local search_path = console')
        await client.query(migration.sql)
        await client.query('insert into console.schema_migrations (version, name) values ($1, $2)', [
          migration.version,
          migration.name,
        ])
        await client.query('commit')
        log.info({ component: 'db', migration: migration.version, name: migration.name }, 'console migration applied')
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', ['buzz-console-migrations']).catch(() => undefined)
    client.release()
  }
}
