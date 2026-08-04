# 🐝 TheHive

Manage [TheHive](https://strangebee.com/thehive/) — the open-source Security
Incident Response Platform (SIRP / SOAR) — as code on the Veltrix
Security-as-Code platform. Author incident-response configuration in the
Configuration Canvas and drive it through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status).

## How it's managed

TheHive exposes a single, uniform **REST API**. This app applies configuration
over that API:

- **REST** — case templates via the TheHive API. Authentication is a TheHive
  **API key** carried as a **Bearer token** (`Authorization: Bearer <key>`),
  stored as the connection credential's API token. TheHive is commonly fronted by
  a **self-signed certificate** (or served directly on `:9000`), which the
  transport tolerates — an explicit `http://` endpoint is honored too.

## Configuration types

| Type | Surface (TheHive 5, primary) | Identity | Status |
|---|---|---|---|
| **Case Templates** | `/api/v1/caseTemplate` (create/update/delete), listed via `POST /api/v1/query` | `name` | ✅ v0.1.0 |
| **Custom Fields** | `/api/v1/customField` (create `POST`, update `PATCH`, delete `DELETE`, list `GET`) | `name` | ✅ v0.2.0 |
| **Observable Types** | `/api/v1/observable/type` (create `POST`, delete `DELETE`, list via query `listObservableType`) — **no update endpoint** | `name` | ✅ v0.2.0 |
| **Users** | `/api/v1/user` (create `POST`, update `PATCH`, delete `DELETE /{id}/force`, list via query `listUser`) | `login` | ✅ v0.2.0 |
| **Organisations** | `/api/v1/organisation` (create `POST`, update `PATCH`, list via query `listOrganisation`) — **no delete endpoint** | `name` | ✅ v0.4.0 |
| **Profiles (RBAC)** | `/api/v1/profile` (create `POST`, update `PATCH`, delete `DELETE`, list via query `listProfile`) | `name` | ✅ v0.4.0 |
| **Page Templates** | `/api/v1/pageTemplate` (create `POST`, update `PATCH`, delete `DELETE`, list via query `listPageTemplate`) — **TheHive 5 only** | `title` | ✅ v0.4.0 |

Each type upserts by its **identity** field (create vs update) and detects drift
against it; deploy snapshots the prior body so rollback can restore it (or delete
what it created).

- **Case Templates** — fields: `name` (identity), `displayName`, `titlePrefix`,
  `severity` (1–4), `tlp` (0–3), `pap` (0–3), `tags`, `description`, and `tasks`
  (one task title per line → prefilled tasks on every case).
- **Custom Fields** — fields: `name` (identity), `displayName`, `group`,
  `description`, `type`, `mandatory`, `options`. `type` is one of
  `string · integer · float · boolean · date · url`. TheHive 5 has **no separate
  `enumeration` type** — an enumerated field is a base type carrying an `options`
  allow-list. Update uses `InputUpdateCustomField`, which omits `name` (a field
  cannot be renamed in place).
- **Observable Types** — fields: `name` (identity), `isAttachment`. TheHive 5
  has **no update endpoint** for observable types, so deploy is
  **create-if-missing**: an existing type is left untouched (an `isAttachment`
  mismatch is reported by drift, not corrected) and rollback deletes only the
  types the deploy created.
- **Users** — fields: `login` (identity, lower-cased by TheHive), `name`,
  `email`, `profile` (role — must already exist in TheHive), `organisation`
  (blank inherits the API key's org). **Passwords and API keys are not managed
  here** — provision them out of band (credential material must not live in
  canvas config). Multi-org membership
  (`PUT /api/v1/user/{id}/organisations`) is out of scope.
- **Organisations** — fields: `name` (identity), `description` (both required
  by TheHive's `InputOrganisation`), `taskRule` / `observableRule` (case/alert
  sharing behaviour — `manual` or `autoShare`), `locked`. **TheHive has no
  delete endpoint for organisations** on either version — they are multi-tenant
  containers for cases/alerts, disabled via `locked` rather than removed. So
  deploy is create/update-only, and rollback of a *created* organisation
  **locks** it (the only safe, available undo) instead of deleting it.
- **Profiles (RBAC)** — fields: `name` (identity), `permissions` (a free-text
  list — one per line or comma-separated). TheHive's permission catalog is
  version-dependent and not fully enumerated by any public client or doc;
  thehive4py's own test suite exercises both bare (`manageCase`) and scoped
  (`manageAlert/create`) forms. Read the exact catalog from your instance's
  Profiles → "Add or Remove Permissions" screen before authoring one here.
  TheHive ships **six built-in profiles** (admin, org-admin, analyst,
  read-only, and — v5.6+ — external-reader/external-actor); only `analyst` is
  documented as editable/deletable — the other five are immutable and TheHive
  rejects a write to them (validate.ts warns, does not block).
- **Page Templates** (Knowledge Base) — fields: `title` (identity), `category`
  (free-text grouping shown in the template picker), `content`
  (markdown/HTML body), `order`. **TheHive 5 only** — this feature has no
  TheHive 4 equivalent (see "TheHive 4 vs 5" below); deploy fails fast with a
  clear message if the seam is pointed at TheHive 4 rather than guessing a v4
  path.

## API dossier

Auth: **Bearer API key** (`Authorization: Bearer <apiKey>`). Base URL is the
TheHive instance (443 behind a proxy, or `:9000` direct). Connectivity check:
**`GET /api/v1/user/current`**.

### TheHive 4 vs 5 — the version seam

The two major versions differ in their case-template surface. This is isolated to
**one place** — `lib/thehiveApi.ts` (`API_VERSION` + `THEHIVE_PATHS`) — so a v4
deployment is a one-line switch.

| Operation | **TheHive 5 (primary)** | TheHive 4 (alternate) |
|---|---|---|
| Create | `POST /api/v1/caseTemplate` | `POST /api/case/template` |
| Get | `GET /api/v1/caseTemplate/{id}` | `GET /api/case/template/{id}` |
| Update | `PATCH /api/v1/caseTemplate/{id}` | `PATCH /api/case/template/{id}` |
| Delete | `DELETE /api/v1/caseTemplate/{id}` | `DELETE /api/case/template/{id}` |
| List / find | `POST /api/v1/query` `{ query: [{ _name: "listCaseTemplate" }] }` | `POST /api/case/template/_search` |
| Current user | `GET /api/v1/user/current` | `GET /api/v1/user/current` |

**Primary is TheHive 5** (StrangeBee). The v5 `_id` and v4 `id` fields are both
read via each type's `*Id()` helper.

The v0.2.0 config types add matching keys to both sides of the seam
(`THEHIVE_PATHS.v5` / `.v4` in `lib/thehiveApi.ts`). The TheHive 4 collection
paths below are the **flagged** legacy alternate — **unverified against a live
TheHive 4**:

| Type | TheHive 5 (primary) | TheHive 4 (alternate, flagged) |
|---|---|---|
| Custom fields | `/api/v1/customField` | `/api/customField` |
| Observable types | `/api/v1/observable/type` | `/api/observable/type` |
| Users | `/api/v1/user` (delete `/{id}/force`) | `/api/user` |

List operations use the v5 query API (`POST /api/v1/query` with
`{ query: [{ _name }] }`) for observable types (`listObservableType`) and users
(`listUser`); custom fields list via a plain `GET /api/v1/customField`.

The v0.4.0 config types (organisations, profiles, page templates) add three more
nuances — this time **confirmed** against the official TheHive 4 OpenAPI spec
(`github.com/TheHive-Project/api-docs`, `thehive.yaml`, archived Jan 2021) rather
than flagged as unverified:

| Type | TheHive 5 (primary) | TheHive 4 (alternate) |
|---|---|---|
| Organisations create/update | `/api/v1/organisation` | `/api/v1/organisation` — **same path**, confirmed present pre-fork |
| Organisations list | query `listOrganisation` | `GET /api/v0/organisation` (legacy collection, confirmed) |
| Profiles (full CRUD) | `/api/v1/profile` | `/api/v0/profile` — **different version**, confirmed |
| Page Templates | `/api/v1/pageTemplate` | **none — TheHive 5 only**, confirmed absent from the spec |

Page Templates (Knowledge Base) is the one surface in this app with no v4
alternate at all — it deliberately bypasses the `THEHIVE_PATHS` seam
(`PAGE_TEMPLATE_PATHS_V5` / `isPageTemplateSupported()` in `lib/thehiveApi.ts`)
rather than pretending a v4 path exists; deploy fails fast with a clear message
if `API_VERSION` is set to `'v4'`.

Sources: TheHive 5 docs — <https://docs.strangebee.com/thehive/api-docs/> and the
Case Templates guides under
<https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-templates/case-templates/>;
`thehive4py` client (v5 endpoints + `InputCaseTemplate`/`InputOrganisation`/
`InputProfile`/`InputPageTemplate` shapes) —
<https://github.com/TheHive-Project/TheHive4py> (`thehive4py/endpoints/` and
`thehive4py/types/`); TheHive 4 OpenAPI spec (confirms the `/api/v0` vs `/api/v1`
organisation/profile split, and the absence of page templates) —
<https://github.com/TheHive-Project/api-docs> (`thehive.yaml`); TheHive 5 admin
guides for profiles, organisations and statuses —
<https://docs.strangebee.com/thehive/administration/profiles/about-profiles/>,
<https://docs.strangebee.com/thehive/administration/organizations/about-organizations/>,
<https://docs.strangebee.com/thehive/administration/organizations/create-an-organization/>,
<https://docs.strangebee.com/thehive/administration/status/create-a-status/>,
<https://docs.strangebee.com/thehive/administration/taxonomies/activate-deactivate-a-taxonomy/>,
<https://docs.strangebee.com/thehive/administration/analyzer-templates/import-analyzer-templates/>.

> ⚠️ **Verify against a live TheHive (note v4 vs v5).** Endpoint paths and the
> exact input field shapes above are derived from the official docs and the
> maintained `thehive4py` client; confirm them against your instance's version
> before trusting deploys. Profile **permission strings** in particular are not
> exhaustively documented anywhere public — read the live catalog from your
> instance's Profiles screen (see "Configuration types" above).

## Coverage

TheHive 5's REST API is large, and much of it is operational (cases, alerts,
tasks, observables) rather than declarative configuration. This app manages the
**standalone, declarative admin surface** — every config type below was
researched against `thehive4py` (the maintained Python client) and, where the
client is silent, the official TheHive 4 OpenAPI spec and StrangeBee's admin
docs (see "API dossier" above for citations). What follows is the full
accounting: **managed**, and **excluded** with the reason — not silently dropped.

### Managed (7 config types)

| Config type | Endpoint(s) |
| --- | --- |
| `case-templates` | `/api/v1/caseTemplate` |
| `custom-fields` | `/api/v1/customField` |
| `observable-types` | `/api/v1/observable/type` |
| `users` | `/api/v1/user` |
| `organisations` | `/api/v1/organisation` (no delete — see above) |
| `profiles` | `/api/v1/profile` |
| `page-templates` | `/api/v1/pageTemplate` (TheHive 5 only) |

### Excluded by design (not a gap — a boundary)

- **Cases, Alerts, Tasks, Observables, Comments, Task Logs, Timelines**
  (`/api/v1/case`, `/api/v1/alert`, `/api/v1/task`, `/api/v1/observable`, …).
  This is TheHive's **operational security-incident data** — the output of
  doing the job the platform exists for, not configuration you author once and
  diff going forward. It also carries case-sensitive investigative content that
  has no business living in a canvas snapshot.
  Cortex is TheHive's separate connected analysis engine — running an
  analyzer/responder is a runtime action against live data, not something to
  validate/deploy/roll back as config.
- **Attack Patterns / Procedures** (`/api/v1/pattern`, `/api/v1/procedure`).
  MITRE ATT&CK technique catalogs imported in bulk and TTPs linked to specific
  cases — reference data and case-linked annotations, not standalone
  declarative objects with an identity to upsert against.
- **MISP integration objects** (`/api/connector/misp/...`). Feed/sync state
  with a connected MISP server — operational integration state, not config
  authored here (a MISP connection is itself configured as a TheHive setting,
  out of this app's API-driven scope).
- **Custom Case/Alert Statuses** (Entities management → Case status / Alert
  status). A real, declarative-shaped admin feature — Stage, Value, Color and
  (5.5+) Visibility per status — **confirmed to exist** via StrangeBee's admin
  docs. But those same docs describe it as managed through the "Entities
  management" UI drawer only, and it appears in **neither** `thehive4py` nor
  the public TheHive 4 OpenAPI spec. Building it would mean guessing an
  unverified endpoint path, which this app does not do (see the "verify
  against a live TheHive" posture throughout). Legitimate follow-up once a live
  instance or an official API reference confirms the endpoint.
- **Taxonomies / Tags** (Administration → Taxonomies). Primarily **MISP-style
  catalogs you activate/deactivate**, not an authored list — the docs describe
  toggling predefined libraries on/off, plus a separate "Add a Custom
  Taxonomy" UI workflow for structured tag libraries (predicates × values ×
  colors). Neither has a verified public REST surface (absent from
  `thehive4py` and the OpenAPI spec), and the activation model doesn't map
  cleanly onto this app's upsert-by-identity pattern. Free-text tags on a
  case/alert/observable are part of that operational data, not config.
- **Analyzer Templates** (Administration → Analyzer templates). Despite the
  name, these are **Cortex analyzer REPORT display/rendering templates**
  imported as a single fixed ZIP archive via the UI — not per-analyzer
  declarative config, and not the same thing as configuring which Cortex
  analyzers/responders are enabled (that lives entirely on the connected
  Cortex instance, a separate product with its own API). No REST endpoint is
  documented or present in `thehive4py`.
- **Dashboards** (KPI / case & alert management metrics). No authoring API was
  found in `thehive4py`, the OpenAPI spec, or the admin docs — every reference
  to dashboards describes *viewing* KPIs, never creating one over REST.
- **"Impact Statuses"** — not found. There is no `impactStatus` concept in
  TheHive 5's documented status model (only Case status and Alert status are
  customizable; task statuses are explicitly hard-coded) or in the observable
  data model (`InputObservable`/`OutputObservable` have no such field). Likely
  a conflation with alert/case status or a MISP/Cortex-side idea — dropped as
  not a verifiable TheHive concept.
- **Automation / integration config** — Notifications, Functions, Feeders,
  the Email Intake Connector, SMTP, and LDAP/SSO authentication settings
  (`user-guides/organization/configure-organization/manage-notifications`,
  `manage-functions`, `manage-feeders`, `administration/email-intake-connector`,
  `administration/smtp`, `administration/authentication`). These are real
  admin screens, but none are covered by the maintained API client, and
  several (SMTP, LDAP) carry credential material that belongs in the platform
  Connection/credential vault, not a config-as-code canvas.
- **Read-only / runtime / licensing surfaces**: current-user session info,
  Cortex analyzer job status polling, license activation, backup/restore,
  cluster/monitoring operations. None of these are declarative configuration.

### Not yet built — legitimate follow-up, not infeasible

- **Organisation links & bulk links** (`PUT /api/v1/organisation/{org}/link/
  {other}`, `/links`) and **sharing profiles**
  (`GET /api/v1/sharingProfile`) — inter-organisation sharing relationships are
  an ORDERED GRAPH between two Organisations (like authentik's Stage/Policy
  bindings), not a flat list of independent items the way every other config
  type here is. Organisations themselves ARE fully managed as standalone
  objects; only the graph edges connecting them are out of scope for this wave.
- **A hardcoded permission-string enum for Profiles.** The permission catalog
  is real and versioned, but not exhaustively published anywhere public (see
  "API dossier"). `permissions` is deliberately free text today; a future wave
  could fetch the live catalog from a connected instance (e.g. via a
  remote-multiselect field) once a stable introspection endpoint is confirmed.

## BYOL infrastructure hosting

Shipped in v0.3.0 (see CHANGELOG) — provision and manage a dedicated,
self-managed TheHive 5 stack from the **Infrastructure** page, alongside the
configuration-as-code pipeline above. Three user-scalable node tiers (TheHive
application, Cassandra, Elasticsearch) plus a fixed MinIO/S3 object store; a
single deployment collapses to one all-in-one node, a distributed deployment
expands every tier (Cassandra ring and Elasticsearch cluster each require ≥3
nodes for HA). The SDK `<ByolInfrastructureManager>` drives create/edit,
plan/apply, and lifecycle actions over the app-owned `/byol` routes; usage is
metered via a daily node-hours ledger. See `infra/spec.ts` for the declared
stack topology and `migrations/002_thehive_byol.sql` /
`003_thehive_byol_usage.sql` for the app-owned schema.

## Notes

TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting. The `thehive_port` setting hints at the API port (443
behind a proxy, or 9000 direct).

Apache-2.0.
