# Netskope

Manage **Netskope** configuration as code through the Netskope REST API v2, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | Netskope surface | Notes |
|---|---|---|
| **URL Lists** | `/api/v2/policy/urllist` | Allow/block lists — exact URLs/IPs or regex patterns. |

URL lists are id-addressed (there is no lookup-by-name), so the app matches a
declared list to a live one by **name** and stores the id from the deploy for
rename-safety. A `PUT` replaces the whole list, so the full desired set of
entries is sent every deploy. Reconcile only deletes lists this app created but
no longer declares.

> **Pending → deploy:** create/update/delete only *stage* a change. The app then
> issues a single `POST /api/v2/policy/urllist/deploy` to apply all pending
> url-list changes on the tenant — so avoid editing url lists elsewhere at the
> same time.

## Authentication

Netskope authenticates with a **REST API v2 token** sent as the
`Netskope-Api-Token` header. In the admin console, go to **Settings > Tools >
REST API v2**, create a token, and grant it the `/api/v2/policy/urllist` and
`/api/v2/policy/urllist/deploy` endpoints with **Read + Write** privilege. Store
the credential as:

- **Password** → the REST API v2 token

Set the app's **Tenant** setting to your tenant host (e.g. `acme.goskope.com`);
the API base is `https://{tenant}/api/v2`.

## Configuration type: URL Lists

Each canvas item is one URL list:

- **Name** — the logical identity (unique in the canvas), ≤ 255 chars.
- **Match Type** — `exact` (URLs/IPs) or `regex` (patterns).
- **Entries** — one URL/IP/pattern per line.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs netskope

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/netskope
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
