# Changelog

All notable changes to the Cribl app are documented here.

## 0.3.0 — 2026-08-04

Exhausts the rest of Cribl Stream's genuinely-declarative REST configuration
surface — 18 new config types across five new/expanded sidebar groups,
researched against the official Cribl OpenAPI spec (v4.14.0, as vendored by
`criblio/terraform-provider-criblio`) and cross-checked against that
provider's own resource docs.

**Knowledge** (new group) — reusable library entries referenced from
Pipelines/Routes/Functions:
- **Lookups** (`system/lookups`), **Regexes** (`lib/regex`), **Grok Patterns**
  (`lib/grok`), **Parsers** (`lib/parsers`), **Event Breakers**
  (`lib/breakers`, order-significant rules as JSON), **Schemas**
  (`lib/schemas`, JSON Schema draft 2019-09), **Global Variables** (`lib/vars`).

**Data Pipelines** (existing group):
- **Subscriptions** (`system/subscriptions`) — stream-to-pipeline bindings.
- **Collectors** (`lib/jobs`) — scheduled/ad hoc data-collection jobs; modeled
  as id + conf JSON (Pipelines-style), matching the real ~9-backend
  discriminated-union body shape.

**Integrations** (existing group):
- **Notification Targets** (`notification-targets`) — reuses the Sources/
  Destinations `{ id, type, ...conf }` engine, extended with a new
  `groupScoped: false` option (this collection is global, not per-group).
- **Notifications** (`notifications`) — alert rules; also global, with Worker
  Group as a genuine body field rather than a path segment.
- **Database Connections** (`lib/database-connections`) — write-only
  `connectionString`/`password`/`configObj`.

**Packs** (new group):
- **Packs** (`m/<group>/packs`) — install/upgrade from a git or registry
  `source`+`spec`, hand-written (not the shared engine) because Cribl's own
  Pack lifecycle is asymmetric: install is a POST with a JSON body, upgrade is
  a PATCH with query-string params; rollback pins the exact prior resolved
  `version` for a reproducible downgrade.

**Security** (new group):
- **Secrets** (`system/secrets`), **Certificates** (`system/certificates`) —
  write-only secret material (value/password/apiKey/secretKey, privKey/
  passphrase), following the same write-only-field convention as
  `apps/cisco-ise`'s internal-users: sent only when non-blank, never captured
  for drift or rollback (an UPDATE is left as-is on rollback; only a
  newly-created record is deleted).
- **Keys** (`system/keys`) — encryption key METADATA only; `plainKey`/
  `cipherKey` are deliberately never sent, so Cribl's local KMS always
  generates the material server-side (mirrors the official Terraform
  provider's own field omission for this resource).
- **HMAC Functions** (`lib/hmac-functions`) — no secret material.

**Worker Groups** (new group):
- **Worker Group Settings** (`m/<group>/system/settings/conf`) — a per-group
  settings SINGLETON (GET+PATCH only). Users declare a partial JSON object of
  just the settings to enforce; drift/rollback use a `deepPick` projection so
  undeclared sibling fields never read as false drift, and rollback restores
  the full live snapshot captured before the deploy's PATCH.

**Shared engine work**:
- `lib/criblRecordEntities.ts` (new) — a generic id+flat-body CRUD engine
  (list/upsert/rollback/drift) for the 14 "named record" config types above,
  parameterized by a per-type `buildRecord()` callback, with `sensitiveKeys`
  and `identityKey` (Keys' wire identity is `keyId`, not `id`) support.
- `lib/criblSystemEntities.ts` — `EntityDescriptor` gained `groupScoped`, so
  Notification Targets can reuse the exact Sources/Destinations engine despite
  not being Worker-Group-scoped.
- `lib/criblCommon.ts` — added `findByKey`, `stripKeys`, `readStringList`.

**Intentionally excluded** (see README "Coverage" for full reasoning):
RBAC (Roles/Policies/Teams/Users — real endpoints exist, but excluded by
Cribl's own official Terraform provider too, and carry credential
lock-out/IdP-federation risk); Worker Group provisioning (topology, not
config — the settings singleton above covers "worker-groups config");
Commit/Deploy (imperative git actions, not desired state); Parquet Schemas
(near-duplicate of Schemas); Pack install via local `.crbl` file upload
(needs a file already on the Cribl box's filesystem); raw key material for
Keys.

Registered 18 new app permissions (one per new config type).

## 0.2.0 — 2026-08-01

Three new config types — the rest of a Cribl Stream data path as code, alongside
Pipelines.

- **Routes** config type — the Cribl **routing table**, managed as code over the
  Cribl REST API (`/api/v1[/m/<group>]/routes`). Routes is a *singleton* per
  Worker Group (one ordered table, id `default`) and Route order is significant,
  so the whole table is modelled as a single item (identity = the table id, the
  payload is the ordered `routes` array), with validate / deploy (upsert by table
  id, order-preserving) / rollback (restore prior table or delete created) /
  order-sensitive drift-detect / health-check / status.
- **Sources** config type — Cribl **input integrations** (`id`, `type`, and a
  `conf` JSON block) over `/api/v1[/m/<group>]/system/inputs`, upserted by input
  id, with rollback, subset-aware drift-detect (only declared keys are compared,
  so Cribl's server-injected defaults raise no false drift), health-check and
  status.
- **Destinations** config type — Cribl **output integrations** (`id`, `type`,
  `conf` JSON) over `/api/v1[/m/<group>]/system/outputs`, sharing the Sources
  engine (`lib/criblSystemEntities`) — same upsert / rollback / drift lifecycle.
- **Shared helpers** — `lib/criblCommon` (worker-group resolution, list-envelope
  unwrap, id/JSON parsing, order-insensitive comparison, and the shared
  health-check + status handlers) and `lib/criblSystemEntities` (the inputs /
  outputs CRUD engine), all reusing the existing `lib/criblApi` Bearer client.
- Registered `routes`, `sources` and `destinations` app permissions.

> Cribl REST API paths and JSON shapes follow the documented Cribl API and should
> be verified against a live Cribl. In particular: Routes is treated as a
> singleton `default` table per group (create is a defensive fallback — Cribl
> normally exposes exactly one table); and Source/Destination config fields are
> flattened onto the object as `{ id, type, ...conf }`.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Pipelines** config type — create / edit / delete Cribl Stream pipelines (an
  id, a target Worker Group / Edge Fleet, and the Function chain as conf JSON) over
  the Cribl REST API (`/api/v1[/m/<group>]/pipelines`), with validate / deploy
  (upsert by pipeline id) / rollback (restore prior or delete created) /
  health-check / drift-detect / status.
- **Access seam** (`lib/criblApi.ts`) — worker-group-aware REST client with
  on-prem login (`POST /api/v1/auth/login` → Bearer) or Cribl.Cloud/direct Bearer
  token, self-signed TLS tolerated.
- **Connectivity test** — obtain a Bearer (login or token), then
  `GET /api/v1/system/info` (HTTPS, self-signed tolerated).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (credential → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Cribl endpoint; saving a connection registers
  `cribl-leader` as a deploy target).

> Cribl REST API paths and the pipeline JSON shape follow the documented Cribl API
> and should be verified against a live Cribl. TLS verification is off by default
> (self-signed) and configurable via the `verify_tls` setting.
