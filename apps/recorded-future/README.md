# Recorded Future (Veltrix app)

Manage **Recorded Future Watch Lists** as code through the Recorded Future
**List API**. Authoring happens in the Veltrix Configuration Canvas; every write
goes through the Security-as-Code pipeline (validate → deploy → health check →
drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Recorded Future API.

## Honest scope: Recorded Future's API is largely READ

Recorded Future is a threat-**intelligence** platform, and its API is
overwhelmingly **read** — entity enrichment / lookup (IP, domain, URL, hash,
vulnerability, threat actor, malware), risk lists, alerts, playbook alerts, threat
maps and detection rules. Those are *queries*, not configuration you author and
deploy.

The one genuinely **writable configuration surface** is the **List API** (Watch
Lists / custom lists — the lists that power queries, Threat Views and Alerts). It
has documented **create** and **add/remove-entity** endpoints, so it maps cleanly
onto the Veltrix pipeline. This app implements that surface as the `watch-lists`
configuration type. (This mirrors the honest-scoping precedent set by the
Cortex XDR and Semgrep apps, whose vendor APIs are similarly read-heavy.)

## What it manages

| Configuration type | Recorded Future endpoint(s)                                                     | Identity  | Write path |
| ------------------ | ------------------------------------------------------------------------------- | --------- | ---------- |
| **Watch Lists**    | `POST /list/create`, `POST /list/{id}/entity/add`, `DELETE /list/{id}/entity/remove` (+ `POST /list/search`, `GET /list/{id}/entities` for reconcile) | List name | **Confirmed** |

Deploy reconciles by the list **name**: it reuses an existing list (found via
`/list/search`) or creates one via `/list/create`, then **adds** every declared
entity that is not already a member. It is **additive** — entities present in
Recorded Future but not declared here are left in place (deploy does not prune).

## API & authentication

Recorded Future exposes a single, cloud-hosted REST API at a **fixed** base URL:
`https://api.recordedfuture.com` (a few customers use a regional / dedicated
cloud, overridable via the `api_base_url` setting or the connection endpoint).

- **Auth:** a single **API token** carried verbatim in the **`X-RFToken`** request
  header on every call (no `Bearer` prefix). Request a token from
  **support.recordedfuture.com → Requesting API Tokens**, scoped to the List API.
  - Confirmed: <https://docs.recordedfuture.com/reference/get-started>
- **List API** (rooted at `<base>/list`):
  - `POST /list/create` — `{ name, type }` → `{ id: "report:…", name, type, … }`
  - `POST /list/search` — `{ name?, type?, limit? (1–100, default 25) }` → JSON array of lists
  - `GET  /list/{id}/info` — list metadata
  - `GET  /list/{id}/status` — `{ size, status: pending|processing|ready }`
  - `GET  /list/{id}/entities` — JSON array of members (no pagination)
  - `POST /list/{id}/entity/add` — `{ entity: { id } | { type, name }, context? }`
  - `DELETE /list/{id}/entity/remove` — `{ entity }`
  - Confirmed: <https://docs.recordedfuture.com/reference/lists-create> (+ `lists-search`, `lists-status`, `lists-add-entity`, `lists-entities` siblings)
- **Connectivity test / health probe:** `POST /list/search { limit: 1 }` — a
  lightweight authenticated call that proves the token is valid **and** List-API
  entitled. Bad / unentitled tokens surface as **HTTP 401 / 403**.

## Configuration notes

- **List `type`** is one of `entity`, `ip`, `domain`, `vulnerability`, `hash`,
  `company`, `attacker`, `executive`, `source`, `text`
  (`POST /list/create` enum).
- **Entities** — one per line (or comma-separated). For `ip` / `domain` / `hash` /
  `vulnerability` lists, enter the plain value (e.g. `8.8.8.8`,
  `evil.example.com`, a SHA-256, `CVE-2024-1234`); Recorded Future auto-resolves
  those via `{ entity: { type, name } }`. For every **other** list type, enter a
  Recorded Future **entity id** (sent as `{ entity: { id } }`) — the docs note
  auto-resolution only works for `IpAddress`, `InternetDomainName`, `Hash` and
  `CyberVulnerability`; other entities must be resolved to an RF id first
  (via Entity Match). The entity-resolution mapping is `VERIFY`-flagged in
  `config-types/watch-lists/_shared.ts`.
- **`comment`** is a local audit note; it is **not** sent to Recorded Future.

## Limitations

- **Read-heavy vendor API.** Only the List API is a real config-write surface; the
  rest of Recorded Future's API is intelligence *lookup*. This app deliberately
  ships just the `watch-lists` type rather than pretending read-only enrichment is
  configuration.
- **No delete-list endpoint.** The List API documents `entity/remove` but **no**
  delete-list operation. Rollback therefore **empties** a list this deploy created
  (removes the entities it added) and reports the leftover empty list for **manual**
  removal in the Recorded Future portal — it cannot delete the list itself.
- **Additive deploy.** Entities present in Recorded Future but not declared here are
  not pruned, to avoid removing members added out-of-band.
- **Best-effort drift / reconcile.** Matching a declared entity to a live member is
  done best-effort by the member's id **or** name; the exact `/list/{id}/entities`
  member shape is `VERIFY`-flagged. When a list can't be found it is reported as
  missing; when its members can't be read, no false drift is asserted.
- Write-only secrets (the API token) are never read back, diffed, or stored in
  rollback data / artifacts / logs.
- The app writes only through the Recorded Future API; it registers no
  platform-side database tables or background jobs.

## Development

```
cd apps/recorded-future
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs recorded-future        # run the config-type tests
node ../../scripts/validate-app.mjs apps/recorded-future # (from repo root) manifest + bundle checks
```
