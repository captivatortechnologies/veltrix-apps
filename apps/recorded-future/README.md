# Recorded Future (Veltrix app)

Manage **Recorded Future Watch Lists**, their entity **tags**, and text feed
files in the Fusion file system as code, through the Recorded Future **List API**
and **Fusion Files API**. Authoring happens in the Veltrix Configuration Canvas;
every write goes through the Security-as-Code pipeline (validate → deploy →
health check → drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Recorded Future API.

## Honest scope: Recorded Future's API is largely READ

Recorded Future is a threat-**intelligence** platform, and its API is
overwhelmingly **read** — entity enrichment / lookup (IP, domain, URL, hash,
vulnerability, threat actor, malware), risk lists, alerts, playbook alerts, threat
maps and detection rules. Those are *queries*, not configuration you author and
deploy.

Two genuinely **writable configuration surfaces** exist on the same host and
credential (`https://api.recordedfuture.com`, `X-RFToken`): the **List API**
(Watch Lists / custom lists, plus the tags on their entities) and the **Fusion
Files API** (text feed files under a customer-writable path). Both have
documented create/read/update/delete endpoints, so they map cleanly onto the
Veltrix pipeline. This app implements exactly those surfaces — see
[Coverage](#coverage-v030) below for the full, re-audited breakdown of what is and
isn't writable. (This mirrors the honest-scoping precedent set by the Cortex XDR
and Semgrep apps, whose vendor APIs are similarly read-heavy.)

## What it manages

| Configuration type | Recorded Future endpoint(s)                                                     | Identity  | Write path |
| ------------------ | ------------------------------------------------------------------------------- | --------- | ---------- |
| **Watch Lists**    | `POST /list/create`, `POST /list/{id}/entity/add`, `DELETE /list/{id}/entity/remove` (+ `POST /list/search`, `GET /list/{id}/entities` for reconcile) | List name | **Confirmed** |
| **Watch List Entity Tags** | `POST /list/{id}/entity/tags` (replace full set) (+ `POST /list/search`, `GET /list/{id}/entitiesWithTags` for reconcile) | List + entity | **Confirmed** |
| **Fusion Files**   | `POST /fusion/v3/files/{path}` (upload — create or overwrite), `DELETE /fusion/v3/files/{path}` (+ `GET`/`HEAD` for reconcile/drift) | File path | **Confirmed** |

**Watch Lists** deploy reconciles by the list **name**: it reuses an existing list
(found via `/list/search`) or creates one via `/list/create`, then **adds** every
declared entity that is not already a member. It is **additive** — entities present
in Recorded Future but not declared here are left in place (deploy does not prune).

**Watch List Entity Tags** manages the tags on entities of a **company-type** list
(a Third-Parties Watch List). Each item declares the **complete** tag set for one
entity; deploy resolves the list, reads the entity's current tags and **replaces**
them with exactly the declared set (`/list/{id}/entity/tags` is authoritative). It
is therefore a **full-set upsert** — drift is exact set-equality, and rollback
restores the entity's prior tag set exactly (a clean, leftover-free undo). Tags are
a **fixed Recorded Future vocabulary** and are capped at **9 per entity**.

**Fusion Files** manages a text feed file's **complete content** at a path under
`/home/...` in Recorded Future's Fusion file system. Deploy reads the file's
current bytes (to learn whether it exists, and for rollback), then uploads the
declared content — a full-content upsert, same shape as Entity Tags. Drift
compares Fusion's own ETag (a SHA-256 of the live bytes) against a locally
computed SHA-256 of the declared content, so the file's bytes are never fetched
back for drift. Rollback deletes a file this deploy created, or restores one it
overwrote to its exact prior content.

Beyond these three, the rest of Recorded Future's API remains read/triage-only —
see [Coverage](#coverage-v030) for the full, re-audited breakdown.

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
  - `GET  /list/{id}/entitiesWithTags` — JSON array of members with their tags (`{ entity, tags: [{ id, name }], … }`)
  - `POST /list/{id}/entity/tags` — `{ entity, tags: [ … ] }` → **replaces** the entity's full tag set (company-type lists only, max 9 tags)
  - Confirmed: <https://docs.recordedfuture.com/reference/lists-create> (+ `lists-search`, `lists-status`, `lists-add-entity`, `lists-entities`, `lists-replace-entity-tags`, `lists-entities-with-tags`, `lists-available-tags` siblings)
- **Fusion Files API** (rooted at `<base>/fusion/v3`, same host + `X-RFToken` —
  a raw-bytes contract, not JSON):
  - `POST   /fusion/v3/files/{path}` — raw body → uploads (creates or overwrites); returns file metadata JSON
  - `GET    /fusion/v3/files/{path}` — the file's raw bytes (`application/octet-stream`)
  - `HEAD   /fusion/v3/files/{path}` — headers only: `ETag` (SHA-256 of the bytes), `Last-Modified`
  - `DELETE /fusion/v3/files/{path}` — removes the file (org files only — `/public/...` cannot be deleted)
  - `{path}` is the **full logical path**, percent-encoded as one segment (`/` → `%2F`); only `/home/...` is customer-writable, `/public/...` is Recorded Future-managed and read-only
  - Confirmed: <https://docs.recordedfuture.com/reference/fusion-files-upload> (+ `fusion-files-get`, `fusion-files-stat`, `fusion-files-delete`, `fusion-files-list-directory` siblings)
- **Connectivity test / health probe:** `POST /list/search { limit: 1 }` — a
  lightweight authenticated call that proves the token is valid **and** List-API
  entitled. Bad / unentitled tokens surface as **HTTP 401 / 403**. (Fusion Files
  shares the same host/token, so this one probe covers both surfaces.)

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
- **Entity tags** (Watch List Entity Tags type) — the `tags` field is the entity's
  **complete** tag set (deploy replaces all existing tags with exactly these). Tags
  are a **fixed** Recorded Future vocabulary (e.g. `tier1`, `critical`, `gdpr`,
  `pci_dss`, `pii`, `financial`, `subsidiary`), applied **only to company-type
  lists**, capped at **9 per entity**. The known-tag list is a best-effort snapshot
  (`config-types/entity-tags/_shared.ts`, `VERIFY`-flagged): an unrecognised but
  well-formed tag is only **warned** about, letting the API be the final authority.
  `matchBy` selects whether the entity value is an RF entity **id** or a **company
  name** (`{ id }` vs `{ type: "Company", name }`).
- **`comment`** is a local audit note; it is **not** sent to Recorded Future.
- **Fusion Files** (Fusion Files type) — `path` must start with `/home/` (the
  customer-writable namespace; `/public/...` is Recorded Future-managed and
  read-only) and may not contain a `..` segment. `content` is the file's
  **complete** text content (deploy replaces whatever is at the path), capped at
  200,000 characters — this type manages **text** feed files (CSV / JSON / plain
  text), not arbitrary binaries. Whether the `/home/{org}/...` org segment must be
  a literal Recorded Future org id is undocumented and `VERIFY`-flagged in
  `config-types/fusion-files/_shared.ts`; the operator supplies the full path.

## Coverage (v0.3.0)

Coverage was re-audited against the live `docs.recordedfuture.com` API reference
on 2026-08-04 — every section of the API index, not the List API alone —
specifically hunting for any other genuinely-declarative write path. See the
CHANGELOG for the full research trail.

### Managed declarative configuration

| Configuration type | Recorded Future API operations |
| --- | --- |
| Watch Lists | `POST /list/create`, `POST /list/search`, `GET /list/{id}/entities`, `POST /list/{id}/entity/add`, `DELETE /list/{id}/entity/remove` |
| Watch List Entity Tags | `POST /list/search`, `GET /list/{id}/entitiesWithTags`, `POST /list/{id}/entity/tags` (full-set replace) |
| Fusion Files | `GET`/`HEAD`/`POST`/`DELETE /fusion/v3/files/{path}` |

All three reconcile by a stable, user-declared identity (list name; list + entity
reference; file path) and capture enough prior state in `rollbackData` for an
exact, leftover-free undo.

### Intentionally excluded

- **ASI (Attack Surface Intelligence) Tagging / Assets / Rules** — genuinely
  writable (asset tag apply/remove/bulk, static-asset scope rules), but on a
  **different product's API entirely**: `api.securitytrails.com`, `apikey`-header
  auth — the SecurityTrails platform Recorded Future acquired, not
  `api.recordedfuture.com`. Out of this app's host/credential model; would be a
  separate app if ever built (the platform's convention for one vendor, multiple
  distinct products — e.g. `cisco-meraki` vs `cisco-ise`).
- **Sandbox YARA rules** — a clean, single, fixed host
  (`sandbox.recordedfuture.com/api/v0`) with simple filename-keyed CRUD, but a
  **distinct Bearer-token auth** the shared `<ConnectionsManager>` this app's
  Connections page uses cannot cleanly onboard alongside the existing
  `X-RFToken` connection (one `componentType` per instance, no second-secret
  field). Deferred pending a proper second-credential UX, not a scoping call.
- **Cases** — genuine CRUD, same host + `X-RFToken` as everything else here, but
  **requires an existing alert** (`alert_rule` + `alert_notification`) and is an
  analyst **triage workflow** (status/assignee/priority over time), not
  idempotent desired state — reconciling it would fight the triage process.
- **Custom Sources** — writable, same host/auth, but a thin `{ name,
  description }` container; the actual content is published *through* it via a
  separate reports endpoint (content publishing, not reconcilable config).
- **Alerting rules, Detection Rules, Playbook Alerts** — read/triage-only: no
  create/update endpoint for rule *definitions*; only triage of existing
  instances.
- **Analyst Notes** — writable, but a document-publishing lifecycle (draft →
  publish → delete), not configuration state.
- **List `textEntries`** — confirmed read-only (no write sibling).
- **Everything else** — entity enrichment/lookup (IP, domain, URL, hash,
  vulnerability, malware, company, threat actor), risk lists, threat maps,
  STIX/TAXII, SOAR enrichment, Links Graph, Collective Insights, Identity
  exposure, Malware Intelligence, RiskRecon — all intelligence *reads*, not
  configuration.

## Limitations

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
- **Fusion Files is text-sized only.** Content is capped at 200,000 characters to
  bound how much prior content a rollback entry retains; it is not a general
  binary file store.
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
