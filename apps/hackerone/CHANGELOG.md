# Changelog

All notable changes to the HackerOne app are documented here.

## 0.2.0 — 2026-08-01

Adds a second, genuinely-writable configuration type after an honest audit of
HackerOne's public write surface (see the note below).

- **Credential Inquiries** configuration type — author, per structured scope, the
  `description` of the information a researcher must provide before a program
  issues them test credentials for that asset. Deployed over the HackerOne API
  (`GET`/`POST`/`PUT`/`DELETE /programs/{id}/credential_inquiries`,
  `type: credential_inquiry`).
- Each inquiry names its target **program by handle** (resolved to a program id
  via `GET /me/programs`) and the **asset (structured scope) by identifier**
  (resolved to a `structured_scope_id` via `GET /programs/{id}/structured_scopes`).
  Because an inquiry attaches to exactly one scope, inquiries are **upserted by the
  scope** they attach to. On create, `structured_scope_id` is sent as a top-level
  sibling of the JSON:API `data` object, as HackerOne documents.
- Full pipeline handler set: `validate`, `deploy`, `rollback`, `healthCheck`,
  `driftDetect`, `getStatus`. Rollback restores an inquiry's prior description, or
  **deletes** an inquiry this app created.
- Refactor: the generic program/scope resolution primitives (handle → id, scope
  indexing, value coercion) moved to `lib/programScopes.ts` and are now shared by
  both config types (DRY); `structured-scopes/_shared.ts` re-exports them, so its
  handlers and tests are unchanged.
- Registered in the manifest (`configurationTypes` + a `credential-inquiries`
  read/write/delete app permission). 14 new unit tests (30 total).

### Honest note on HackerOne's write surface

HackerOne's public **write** API is deliberately thin. Against the official
customer API (`https://api.hackerone.com/customer-resources/`) and the reference
client (`github/hackerone-client`), the candidates considered for this release
resolved as follows:

- **program-members / group-members** — no documented `POST`/`PUT`/`DELETE`
  endpoints. NOT writable via the public API. Not added.
- **common-responses (saved triage responses)** — read-only (`GET` only) in the
  public API. NOT writable. Not added.
- **organization asset-management** (the post-`2026-04-07` home for assets) — only
  `GET` (read) endpoints are exposed in the customer API; no confirmed public
  `create`/`update` for assets. NOT added (a write path could not be confirmed
  without inventing one).
- **Credentials** (shared test-account credentials; `type: credential`) — IS
  writable (`POST`/`PUT`/`DELETE` + assign/revoke), but the request body carries
  **secret** credential material (a JSON-encoded secret hash) and has no clean
  non-secret identity for upsert/drift. Deliberately **declined** — storing
  secrets in declarative canvas config is the wrong shape. This is a candidate for
  a future secret-aware design, not a plain config type.
- **Credential Inquiries** (`type: credential_inquiry`) — IS writable, non-secret,
  declarative, and one-per-scope with a single writable attribute
  (`description`). This is the genuine add in this release.

Net: of the resources reviewed, **one** is added as a config type
(Credential Inquiries); a second writable resource (Credentials) exists but was
declined on security grounds.

### Flagged for verification against live HackerOne

- The **Credential Inquiries** endpoints require the **Team Management** permission
  on the API token; the read-only `healthCheck` probe (`GET /me/programs`) does not
  exercise that permission, so a token lacking it will pass health but fail deploy.
- The linkage between a listed credential inquiry and its structured scope — read
  either from an attribute (`structured_scope_id`) or a JSON:API relationship
  (`relationships.structured_scope.data.id`) in `_shared.inquiryScopeId` — should
  be verified against the live list response, as the upsert-by-scope match depends
  on it.

## 0.1.0 — 2026-08-01

Initial foundation.

- **Structured Scopes** configuration type — author a HackerOne program's asset
  scope as code: asset type, asset identifier, submission / bounty eligibility,
  max severity and tester instruction. Deployed over the HackerOne API
  (`https://api.hackerone.com/v1`, HTTP Basic auth, JSON:API).
- Each scope names its target **program by handle**; the handle is resolved to a
  program id via `GET /me/programs`, and the asset is **upserted by identifier**
  within that program (`GET`/`POST /programs/{id}/structured_scopes`,
  `PUT /programs/{id}/structured_scopes/{id}`).
- Full pipeline handler set: `validate`, `deploy`, `rollback`, `healthCheck`,
  `driftDetect`, `getStatus`. Rollback restores prior scope attributes or archives
  scopes this app created.
- HTTP Basic auth API client (`lib/hackeroneApi.ts`) with JSON:API pagination,
  plus a connection connectivity test (`GET /me/programs`).
- Client pages: Overview, Setup Guide, Connections (fixed host `api.hackerone.com`;
  credential = API token identifier as username + token value as secret).
- No BYOL / no database — HackerOne is a pure SaaS API.

### Flagged for verification against live HackerOne

- HackerOne removed the program-level **create / update / archive** structured-scope
  endpoints from its public docs on **2026-04-07** (assets are now managed via
  organization asset-management endpoints). The `GET` (list) endpoint remains
  documented. The write path and request envelope
  (`{ data: { type: "structured-scope", attributes } }`) should be verified against
  the live API — and may need to move to the organization asset-management endpoints.
- The exact `asset_type` machine enum set has varied across API revisions; verify
  the values in the canvas select if any type is rejected.
