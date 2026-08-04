# Changelog

All notable changes to the runZero Veltrix app are documented here.

## 0.3.0 — 2026-08-04

Config-as-code exhaustion pass. Re-verified the FULL runZero API against the official OpenAPI spec
(runZeroInc/runzero-api, `runzero-api.yml`, `info.version: 1.0.5`) — every path/operation was
enumerated and classified. Adds seven new configuration types for genuinely-declarative writable
resources found by that audit, and re-confirms every prior drop still holds.

- **Organizations** configuration type — manage runZero Organizations (tenant containers for sites,
  assets and scans): name, description, hierarchy (`parentId`) and data-retention settings, applied
  over `/account/orgs` (`PUT` create, `PATCH` update, `DELETE` remove). Upserts by name.
  **ACCOUNT-scoped** — requires an account-scoped API key. **Rollback of a create deletes the
  organization**, cascading to everything created under it since — called out in validate/README.
- **Users** configuration type — manage runZero user accounts: name, a default role and
  per-organization role overrides, over `/account/users` / `/account/users/invite` (`PUT` create —
  direct or email-invite — `PATCH` update, `DELETE` remove). Upserts by email. **No secrets are ever
  set or read** — password reset stays an out-of-band, non-declarative action. ACCOUNT-scoped.
- **Groups** configuration type — runZero's closest analogue to a "role" resource (there is no
  separate role CRUD endpoint): a default role plus per-organization role overrides applied to every
  member, over `/account/groups` (`POST` create, `PUT` update — full object, id inside, the same
  shape scan-templates already uses — `DELETE` remove). Upserts by name. ACCOUNT-scoped.
- **SSO Group Mappings** configuration type — maps an identity-provider attribute/value pair to a
  runZero Group, over `/account/sso/groups` (`POST` create, `PUT` update, `DELETE` remove). Upserts
  by the (SSO Attribute, SSO Value) composite identity — there is no single-field identity for this
  resource. ACCOUNT-scoped.
- **Asset Ownership Types** configuration type — the asset-ownership picklist (e.g. "Asset Owner",
  "Security Contact"). Unlike every other config type in this app, runZero exposes this as a BATCH
  resource — `POST` / `PUT` / `DELETE /account/assets/ownership-types` all take/return arrays — so
  deploy/rollback send at most one batch call per direction per run instead of one call per item.
  Upserts by name. ACCOUNT-scoped.
- **Custom Integrations** configuration type — registers a custom integration's identity
  (name/icon/description) for third-party asset-data feeds, over `/account/custom-integrations`
  (`POST` create, `PATCH` update, `DELETE` remove). Registration metadata only — the Starlark
  ingestion script itself is authored separately (Custom Integration Scripts) and is not part of
  this API. Upserts by name; the name must not contain spaces (enforced at validate). ACCOUNT-scoped.
- **Explorer Settings** configuration type — tunes an already-installed Explorer's Site assignment
  and scan concurrency via `PATCH /org/explorers/{id}`. **No create/delete** — Explorers are
  installed/uninstalled out-of-band, so every item must reference one that already exists. Max
  Concurrent Scans is **write-only** (the same shape as Cisco Meraki's `syslog_default_rule` in this
  repo) — runZero never reports the current value back, so drift detection never compares it and
  rollback never restores it; every deploy re-applies whatever is declared. Site assignment fully
  round-trips. Uses the existing Organization API key (org-scoped, unlike the six types above).

### Re-verified prior drops (all CONFIRMED correct against the OpenAPI spec, still excluded)

- **Hosted zones** (`/org/hosted-zones[/{id}]`) — still `GET` only, no write verb of any kind.
- **Saved queries** — still no `/org/queries` or any query-resource path exists anywhere in the spec;
  the Queries UI page is not backed by a CRUD API.
- **Rules/reports config** — still no `/org/rules` or `/account/reports` path exists; the rules
  engine and reporting UI are not backed by a CRUD API either.
- **Credentials** (`/account/credentials`) — still `PUT` create + `DELETE` only, no update verb, and
  the response never carries the secret back — still a poor upsert/drift fit and still carries
  secret material, so still dropped.

### Intentionally excluded (new, from this audit)

- **Account API keys/export tokens** (`/account/keys`, `/account/orgs/{id}/exportTokens`) — these
  mint/rotate bearer secrets, the same category as Credentials above; not modeled as config.
- **Asset-level tag/owner/criticality writes** (`/org/assets/**`, incl. the bulk-by-search-query
  endpoints) — these mutate the dynamic, scan-discovered asset inventory itself (matched by asset id
  or a live search query), not a stable named resource with an upsert identity; an imperative
  operation, not durable desired state.
- **User MFA/lockout/password-reset actions** (`/account/users/{id}/reset*`) — one-shot account
  actions, not declarative state.
- **Scan data import** (`/org/sites/{id}/import*`), **traffic sampling** (`/org/sites/{id}/sample`)
  and **legacy Agent paths** (`/org/agents/**`, superseded by `/org/explorers/**`) — one-off/imperative
  operations or deprecated aliases of an already-managed endpoint.
- Every `/export/**` path (assets/services/sites/wireless/software/vulnerabilities/certificates/
  users/groups/findings/tasks/…, plus the Splunk/ServiceNow/Cisco-SNTC integration exports) and
  `/account/events*` — read-only reporting/export surfaces.

## 0.2.0 — 2026-08-01

Adds two scan-lifecycle configuration types alongside Sites.

- **Scan Tasks** configuration type — manage recurring scans of a Site as code: name,
  target scope, frequency (once / hourly / daily / weekly / monthly / continuous) and
  optional tuning (excludes, TCP ports, rate, tags, template), applied over the runZero
  console REST API.
  - Deploy upserts a recurring scan by `(site, scan name)`: `PUT /org/sites/{site}/scan`
    (runZero creates scans with **PUT**, not POST) to schedule, `PATCH /org/tasks/{id}` to
    update an existing recurring task. A `once` scan runs one-off and is not drift-tracked.
  - Rollback stops schedules this deploy created (`POST /org/tasks/{id}/stop` — runZero has
    no delete-a-task verb) and restores updated tasks to their prior body.
  - Drift detection confirms each recurring scan still exists and its frequency matches;
    a missing scan is critical drift.
  - Health check verifies the org's task list is reachable and the key authenticates
    (`GET /org/tasks`).
- **Scan Templates** configuration type — manage reusable, named scan-parameter sets a scan
  task can be based on, with full CRUD over `/account/tasks/templates` (list / create via
  **POST** / update via **PUT** the full object / delete by id).
  - Deploy upserts by template name; rollback deletes created templates and restores updated
    ones. Drift compares description, the global flag and the parameter map.
  - **Scope note:** scan templates are **account-scoped** resources in runZero, so this
    configuration requires the connection's API key to be an **account-scoped** key — an
    Organization key is rejected by `/account/*` (surfaced by the health check). The target
    organization is resolved from `GET /org` (or an explicit Organization ID field).

Dropped from the original scope after checking the runZero OpenAPI spec: **hosted-zones**
(read-only — `GET` only, not a deploy target), **credentials** (exist only under
`/account/credentials`, create+delete only with no update verb, and carry secrets — a poor fit
for upsert/drift) and **saved queries** (no saved-search endpoints exist in the API).

## 0.1.0 — 2026-08-01

Initial foundation.

- **Sites** configuration type — manage runZero Sites (the scan-scope containers
  assets are grouped under) as code: name, description and the default scan scope
  (subnets/CIDRs), applied over the runZero console REST API (`/org/sites`).
  - Deploy upserts each site by name: `PUT /org/sites` to create, `PATCH /org/sites/{id}`
    to update.
  - Rollback deletes sites this deploy created and restores updated sites to their
    prior body.
  - Drift detection compares description and scan scope (set-based) and flags a
    missing site as critical drift.
  - Health check verifies the org is reachable and the API key authenticates
    (`GET /org/sites`).
- **Connections** page + connectivity test — one connection per runZero organization,
  reached at the hosted console (`console.runzero.com`, overridable for self-hosted
  runZero Platform) and authenticated by an Organization API key (Bearer). The test
  calls `GET /org/sites`.
- **Overview** and **Setup Guide** pages.
- No database and no BYOL — runZero is a SaaS reached over its REST API.
