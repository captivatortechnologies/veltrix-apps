# Changelog

All notable changes to the HackerOne app are documented here.

## 0.3.0 — 2026-08-04

Re-audits HackerOne's FULL public write surface against the live API reference
(customer-resources + customer-reference, verified 2026-08-04) and adds four new
configuration types — the largest single addition since the app's foundation.
See the README's **Coverage** section for the complete endpoint-by-endpoint
classification.

- **Program Policy** (`program-policy`) — author a program's disclosure /
  bug-bounty policy text (the document shown to researchers on the program's
  page). One item per program; deploy replaces the entire document
  (`PUT /programs/{id}/policy`, `type: program-policy`). Requires the Program
  Management permission on the API token.
- **Scope Exclusions** (`scope-exclusions`) — author named report categories
  excluded from a program's scope / rewards, in addition to its core ineligible
  findings (e.g. "Denial of Service"). Full CRUD, upserted by `category`
  (`GET/POST/PUT/DELETE /programs/{id}/scope_exclusions[/{id}]`,
  `type: scope-exclusion`). Unlike Structured Scopes, this has a genuine
  `DELETE` — no archive-vs-delete ambiguity. Requires Program Management.
- **Assets** (`assets`) — author an **organization**-level Asset inventory
  (`asset_type`, `identifier`, `description`, `max_severity`, CVSS environmental
  CIA requirements, `reference`). This is the confirmed, non-deprecated
  successor to the program-level structured-scope create/update endpoints
  HackerOne removed from its docs on 2026-04-07 (flagged in 0.1.0/0.2.0 as
  "could not confirm a write path" — now fully confirmed). Upserted by
  `identifier` via `filter[identifier]`
  (`GET/POST /organizations/{id}/assets`,
  `PUT /organizations/{id}/assets/{assetId}`,
  `POST /organizations/{id}/assets/archive` — a **bulk** archive endpoint is
  HackerOne's only delete path here; there is no per-id `DELETE`).
  `asset_type`/`identifier` are immutable after creation — HackerOne's own
  Update Asset body omits them, and this app's `deploy`/`rollback` never send
  them on update.
- **Asset Scopes** (`asset-scopes`) — attach an organization Asset (by
  identifier) to a program's scope (by handle): eligibility for
  submission/bounty, tester instruction, researcher notification. The write
  path is new
  (`POST /organizations/{id}/assets/{assetId}/scopes`,
  `PUT .../scopes/{id}`,
  `POST .../scopes/archive` bulk-keyed by **program** id), but the read side
  reuses the still-documented `GET /programs/{id}/structured_scopes` — the
  live resource returned is still `type: structured-scope`. `max_severity`
  moved from a per-(program, scope) attribute to a property of the Asset
  itself (set once in `assets`, shared across every program it is scoped to).
- New shared lib: `lib/organizations.ts` (organization handle → id resolution,
  asset lookup by identifier) and `HackerOneClient.listOrganizations()` in
  `lib/hackeroneApi.ts` — mirrors the existing program-resolution primitives in
  `lib/programScopes.ts` one level up.
- 44 new unit tests (85 total, all network-free — deploy/rollback/drift call the
  live HackerOne API over fetch and are exercised by the pure `_shared.ts`
  helpers plus `validate.ts` instead, matching the existing convention).

### Honest note on this release's exhaustion pass

Re-verified against the raw HackerOne API reference/resources pages (not just
search-result summaries, which proved inaccurate on exact paths in a few cases —
see Flagged below). Candidates considered and their disposition:

- **Weakness / CWE config** — `GET /programs/{id}/weaknesses` is read-only; the
  only write is `PUT /reports/{id}/weakness`, which sets a **specific report's**
  weakness, not program-level CWE configuration. NOT writable as declarative
  config. Not added.
- **Custom Field Attributes** (the field *definitions*, not per-report values) —
  confirmed **UI-only** (HackerOne's own Help Center: "Security page >
  Customizations > Custom fields"); the public API only lets you *reference* an
  existing attribute's numeric id when setting `PUT /reports/{id}/custom_field_values`.
  No create/update/delete endpoint exists. Not added.
- **Inbox / Triage rules** — `GET /organizations/{id}/inboxes` is the only
  inbox-related endpoint (read-only). No triage-rule resource exists in the
  public API. Not added.
- **Automations** (the "triggers" candidate) — `GET/POST/PATCH
  /organizations/{id}/automations` IS fully writable and declarative (`title`,
  `code`, `template_identifier`, `config`, `events[]`, `enabled`,
  `run_once_per_report`) and uses `PATCH` (not `PUT`, unlike everything else in
  this API). **Deliberately declined**: HackerOne's own docs confirm `code` is
  arbitrary **Node.js 20 JavaScript**, executed with the permissions of a
  dedicated "Automations" organization-member group that carries **all
  organization, engagement, and asset-level permissions** — i.e. this stores and
  runs arbitrary, org-wide-privileged code from declarative canvas config. Same
  class of decision as declining Credentials in 0.2.0 (storing secrets in
  canvas config was the wrong shape); storing/executing arbitrary
  org-privileged code is the wrong shape for the same reason, doubly so. A
  future dedicated, security-reviewed design is a fair candidate; this release
  does not build one. Also has no confirmed archive/delete path (`archived` is
  read-only in the response; `PATCH` doesn't accept it).
- **Organization Groups / Member roles** (RBAC) — `POST/PUT
  /organizations/{id}/groups` (`type: organization-member-group`) IS writable
  (`name`, `permissions[]`, `eligibility_setting_id`, plus relationships to
  specific members/programs/inboxes) — reversing 0.2.0's note that
  "group-members" had no documented write endpoint (that note was about
  *membership*, not the group entity; the entity itself is writable). Declined
  for this release: it is organization-wide identity/access-control
  administration (which members get which permissions org-wide), a distinct
  security-admin surface outside this app's program-scope/asset-inventory
  boundary — the same reasoning other Veltrix apps use to keep RBAC as its own
  dedicated IDP-app surface rather than a bolt-on. A candidate for a future,
  purpose-built config type.
- **Campaigns** — `POST /programs/{id}/campaigns` IS writable, but is a
  time-boxed, financially-consequential workflow (`bounty_pool_limit`, real
  payouts) with an explicit non-idempotent `Launch`/`End` action distinct from
  create — does not fit the idempotent-upsert-with-safe-rollback shape this
  pipeline assumes. Declined.
- **Findings Workboards / Views** (ASM saved views) —
  `POST /organizations/{id}/findings/workboards[/{id}/views]` IS writable
  (full CRUD), but is a saved-search / dashboard-layout convenience in the
  separate Attack Surface Management "Findings" subsystem, not security-relevant
  declarative state. Declined as out of this app's scope (comparable to how
  `apps/cisco-meraki` excludes device-scale / UI-convenience resources).

### Flagged for verification against live HackerOne

- **Assets / Asset Scopes required permission** — unlike every other resource
  in HackerOne's published API reference, the Create/Update/Archive Asset and
  Add/Update/Archive Asset-Scope endpoints state **no** "Required permissions"
  line. Verify the actual required token scope against a live organization
  before depending on this in production.
- **`notify_subscribers_on_changes` vs. `notify_subscribers_of_changes`** —
  HackerOne's own documented request bodies use a different key for the same
  boolean on create (`_on_changes`) vs. update (`_of_changes`) of an asset
  scope. Both are sent verbatim, per operation, in this app — very likely a
  documentation typo on HackerOne's side, not independently verified against a
  live program.
- **Asset identifier reconciliation** — the `asset` object's response echoes
  `identifier` generically AND under a type-specific alias (`domain_name` for
  `asset_type: domain`, etc.); this app reads the generic `identifier` field
  only. Confirmed present in the reference schema, but worth re-checking if a
  live response ever omits it.

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
