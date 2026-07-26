# Cisco Duo

Manage **Cisco Duo** configuration as code through the Duo Admin API, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | Duo Admin API surface | Notes |
|---|---|---|
| **Groups** | `/admin/v1/groups` | Duo groups — name + description. |

Duo objects are addressed by an opaque `group_id` (there is no lookup-by-name),
so the app matches a declared group to a live one by **name** and stores the
`group_id` from the deploy for rename-safety on the next deploy. Reconcile only
deletes groups this app created but no longer declares.

## Authentication

The Duo Admin API uses **HMAC-SHA1 request signing**. Protect an **Admin API**
application in the Duo Admin Panel and store the credential as:

- **Username** → the **Integration key**
- **Password** → the **Secret key** (used as the HMAC key — never sent directly)

Set the **API Host** (`api-XXXXXXXX.duosecurity.com`) in the app's settings, and
grant the integration the read information + read/write resources permissions.
Every request is signed with an HMAC-SHA1 signature over a canonical
`date · method · host · path · sorted-params` string; params are form-encoded and
lists page via `metadata.next_offset`.

## Configuration type: Groups

Each canvas item is one group:

- **Name** — the logical identity (unique in the canvas), ≤ 255 chars.
- **Description** — optional, ≤ 255 chars.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs cisco-duo

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/cisco-duo
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
