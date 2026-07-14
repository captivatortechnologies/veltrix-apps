# ADR 0001 — App-owned database schema & isolation

Status: Accepted · Date: 2026-07-12

## Context

Apps extend the platform with their own configuration types, routes, and data.
Historically, a first-party app's tables were hand-added to the platform's
central Prisma schema (`server/prisma/schema.prisma`) and read through typed
Prisma delegates (e.g. `db.splunkEnterpriseIndexesDefaultConfiguration`).

That does not generalise:

- **Marketplace builders have no access to the platform database or its Prisma
  schema.** They cannot add models to `schema.prisma`, so any app whose data
  lives there is not portable.
- **Self-managed apps** (authored and owned by a customer) are less trusted than
  first-party code and must not be able to read or clobber platform tables or
  another tenant's data.

The platform already ships the primitives for app-owned data
(`manifest.database`, an `AppMigrationRunner`, and the raw-query
`PlatformDatabaseClient`), but nothing enforced ownership, and the flagship
Splunk app bypassed them.

## Decision

### 1. Apps bring their own schema

An app declares its tables in `manifest.database` and ships SQL under
`migrations/`:

```yaml
database:
  migrations: migrations       # dir of *.sql, applied in filename order
  tablePrefix: splunk_         # every object the app creates is namespaced
  isolation: shared            # optional; see below
```

On install, `AppRegistry` runs `AppMigrationRunner.runMigrations`, which applies
each file once, tracked by `(app_id, filename, checksum)` in the platform
`app_migrations` table. Applied migrations are immutable (checksum-guarded);
changes go in a new migration. Apps read/write their tables through the raw
escape hatches on `PlatformDatabaseClient` (`$queryRawUnsafe` /
`$executeRawUnsafe`) — there is no generated Prisma model for an app table.

### 2. Isolation tiers

A ladder of increasing isolation, declared via `manifest.database.isolation`:

- **`shared`** — the app's tables live in the shared `public` schema and every
  object it creates/alters/drops must be namespaced with its `tablePrefix`.
  Reserved for **trusted first-party (`BUILT_IN`) apps** whose SQL the platform
  ships and reviews.
- **`schema`** — the app gets its own Postgres schema (`app_<appId>`) **and a
  dedicated least-privilege role that owns it**; its migrations run inside a
  transaction with `search_path` pinned to the schema and `SET LOCAL ROLE`, so
  the database itself confines it. Uninstall is `DROP SCHEMA ... CASCADE` plus
  dropping the role.
- **`database`** — the app gets its own Postgres **database** (`app_<appId>`).
  Because Postgres has no cross-database queries, the app cannot reach platform
  data at all; migrations run there over a dedicated connection derived from the
  platform `DATABASE_URL`, with tracking kept inside the app database. Buys
  blast-radius / noisy-neighbour isolation. Uninstall is `DROP DATABASE`.
- **`external`** — the app owns its datastore entirely (bring-your-own store);
  the platform manages no schema for it and runs no migrations. Its connection
  is supplied at runtime via app settings.

**The platform decides** from the install source and may only raise isolation,
never lower it below the floor:

| Install source            | Floor | May opt up to |
| ------------------------- | ----- | ------------- |
| `BUILT_IN` (first-party)  | `shared` (or manifest value) | any |
| `MARKETPLACE`             | `schema` | `database`, `external` |
| `CUSTOM` (self-managed)   | `schema` | `database`, `external` |

Self-managed apps therefore always get a hard, Postgres-enforced boundary; for
`schema`/`database` the boundary *is* the schema/database, so those tables don't
need a `customer_id` column.

### 3. Ownership guard (defense in depth)

Every migration statement is statically checked before it runs
(`assertStatementOwnership`), and again at build time by the CLI validator
(`validateMigrationOwnership`), so a bad migration fails on `veltrix validate`,
not in production:

- Role/user/database/schema/extension/function DDL and `GRANT`/`REVOKE`/`COPY`
  are forbidden outright.
- Any schema-qualified reference must point at the app's own schema
  (`schema` mode) or must not name a protected schema like `public`
  (`shared` mode).
- Under `shared` isolation, each created/altered/dropped object name must
  contain the app's `tablePrefix` token (accepts both `splunk_x` and
  `idx_splunk_x`).

For `schema`-isolated apps this is backed by a **per-app least-privilege
Postgres role**: the installer creates a `NOLOGIN` role that *owns* the app's
schema, and migrations run as that role (`SET LOCAL ROLE`) inside the pinned
`search_path` transaction. The database itself then rejects any read or write
against platform tables — even a statement the static regex guard might miss.
The platform's login user is made a member of the role so it can assume it on
its own pooled connection; no per-app credential or connection is introduced.
If the platform's DB user lacks role-management rights, the runner logs and
falls back to schema + `search_path` + guard isolation, so installs never break.
Uninstall drops the schema **and** the role.

### 4. Platform-owned tables stay platform-owned

Data consumed by **platform services** is not app data even if it looks
domain-specific. BYOL infrastructure, `SplunkVersion`, and `SplunkUpgrade`
remain in the central schema because the provisioning pipeline (rabbitmq,
webhooks, api-key scoping) reads and writes them directly. A first-party app may
surface them via typed delegates; those are platform tables it is trusted to
read, not app-owned tables.

Only genuinely app-scoped data — the Splunk **index/role default
configurations** — moved into the app (`migrations/002_splunk_domain.sql`,
`splunk_`-prefixed, accessed through `apps/splunk-enterprise/lib/db`).

## Consequences

- `schema.prisma` no longer contains app-config tables; it holds only
  platform-owned models.
- New app tables never touch the central schema; they ship in the app.
- Cross-boundary references (an app row pointing at a platform `customer`,
  `user`, or `tag`) are stored as plain UUID columns with **no** cross-schema
  foreign key; the app enforces the relationship in code.
- Losing typed Prisma models for app tables is the tradeoff for portability;
  the per-app `lib/db` raw-SQL layer (with row→DTO mappers) contains that cost
  in one place.
