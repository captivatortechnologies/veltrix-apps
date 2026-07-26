# Prisma Cloud

Manage **Palo Alto Prisma Cloud (CSPM)** configuration as code through the Prisma
Cloud REST API, with validation, drift detection and rollback handled by the
Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | Prisma Cloud surface | Notes |
|---|---|---|
| **Compliance Standards** | `/compliance` | Custom compliance standards — name + description. |

Standards are matched by **name** (Prisma Cloud has no lookup-by-name and enforces
name uniqueness). Built-in (system default) standards are protected — the app
never modifies them. Because `POST /compliance` returns no id, the app re-fetches
the standard list to resolve the new id after a create. Reconcile only deletes
standards this app created but no longer declares.

## Authentication

Prisma Cloud authenticates with an **access key**. In **Settings > Access Control
> Access Keys**, create a key (ideally for a service account with a role that can
manage compliance standards). Store the credential as:

- **Username** → the Access Key ID
- **Password** → the Secret Key

Set the app's **API URL** to your tenant's API host (e.g.
`https://api.prismacloud.io`; regions differ — `api2`, `api.eu`, `api.anz`,
`api.gov`, …). The app logs in (`POST /login`) for a short-lived JWT sent as the
`x-redlock-auth` header, re-logging in automatically when it expires.

## Configuration type: Compliance Standards

Each canvas item is one standard:

- **Name** — the unique identity (server-enforced), ≤ 255 chars.
- **Description** — optional, ≤ 2000 chars.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs prisma-cloud

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/prisma-cloud
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
