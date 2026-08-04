# Changelog

All notable changes to the Velociraptor app are documented here.

## 0.4.0 — 2026-08-04

Config-as-code write-surface exhaustion pass: four new configuration types plus
a custom-ACL extension to Users & ACLs, all driven over the same gRPC/mTLS VQL
seam. Researched against the Velociraptor VQL source
(`vql/server/{labels,inventory,secrets,notebooks,hunts,timelines,favorites,clients,orgs}`)
and `acls/acls.go` / `acls/roles.go` — see README Coverage for what was
evaluated and honestly dropped (hunts, notebooks, timelines and favorites are
runtime DFIR/investigation actions, not durable desired state).

- **Secrets** config type (new) — named secret definitions (e.g. SMTP
  credentials, cloud API keys) artifacts can reference without exposing the raw
  value, plus who can read them. Content is write-only (`secret_add()`, sent on
  every deploy, never read back — the server never returns it); grants
  (users/orgs/visible-to-all-orgs) are reconciled to an exact desired state via
  `secret_modify()`'s additive/subtractive add/remove-list arguments, diffed
  against `secrets()` metadata. Rollback deletes a secret this deploy created,
  or reverses the grant delta for one that already existed; content is never
  restored (same limitation as an authored password field).
- **Client Labels** config type (new) — pin a Velociraptor client label to an
  explicit, bounded list of client ids (a static security-group-style
  assignment, not a fleet-wide dynamic rule). Reconciled via `label(client_id=,
  labels=[...], op='set'|'remove')`, read back via `clients(search='label:...')`.
  Deploy/rollback use a symmetric added/removed delta (mirrors this monorepo's
  JumpCloud group-memberships pattern) so rollback never needs to re-read live
  state.
- **Server Metadata** config type (new) — free-form server-level key/value tags
  (environment, owner, compliance tier, ...) via `server_metadata()` /
  `server_set_metadata()`. Upsert-only: only the declared keys are touched, so
  other metadata the server (or another process) already carries is preserved.
- **Third-Party Tools** config type (new) — pin the third-party binaries
  Velociraptor artifacts download to endpoints (version, URL, SHA-256 hash,
  serve-locally) via `inventory_add()` — a supply-chain integrity control. A
  hash mismatch is critical drift; a missing hash is a validation warning.
  Velociraptor's inventory API has no delete/remove plugin, so rollback can
  restore a tool's prior definition but cannot un-add one this deploy created —
  flagged honestly rather than silently reported as reverted.
- **Users & ACLs — fine-grained custom permissions** — a new optional "Custom
  Permissions" field grants ACL permissions BEYOND the 7 named roles (e.g.
  `execve`, `filesystem_read`) via `user_grant(policy={...})`, applied and
  reversed as an explicit true/false delta against `gui_users()`'s prior policy
  (best-effort, same "may not be surfaced" caveat as role read-back). Unknown
  permission names are warned, not rejected, matching the existing role
  validation posture.
- **`vqlJson()`** (`lib/velociraptorApi.ts`) — a shared `parse_json(data=<json>)`
  VQL-argument builder, reused by all four new config types and the Users & ACLs
  policy extension (existing per-type `set*VQL()` builders keep their own inline
  form, unchanged).
- **`lib/clientId.ts`** (new) — Velociraptor's `C.<hex>` client-id format check,
  mirroring the existing `lib/artifactName.ts` pattern; used by Client Labels.

> New VQL surfaces in this release — `label()`, `server_metadata()` /
> `server_set_metadata()`, `secret_add()` / `secret_modify()` / `secrets()`,
> `inventory_add()` / `inventory()`, and `user_grant()`'s `policy` argument —
> are real Velociraptor server functions per the public source, but their exact
> argument/column shapes (especially JSON casing of ACL permission names, and
> whether `secret_add()` / `inventory_add()` upsert or error on a duplicate) are
> flagged `VERIFY` in code and should be reconciled against a live Velociraptor
> server before production use.

## 0.3.1 — 2026-08-01

Hardened config validation: custom artifacts are now parsed as real YAML and
checked against Velociraptor's artifact schema, instead of a regex sanity check.

- **Custom Artifacts — real YAML parse + schema validation** — the definition
  YAML is now parsed with the `yaml` package (YAML 1.2) and checked structurally
  (`validateArtifactDefinition`, in `_shared.ts`):
  - a YAML **syntax error** is now a hard validation error, caught before deploy
    (previously invisible to the regex sanity check — the biggest gap this closes)
  - the root must be a **mapping**, not a scalar or a list
  - `name:` is required, a string, and dotted-alphanumeric — cross-checked against
    the item's `name` field (mismatch is a warning; the server keys on the
    definition's name)
  - `type:`, if present, must be one of `CLIENT` / `SERVER` / `CLIENT_EVENT` /
    `SERVER_EVENT` / `NOTEBOOK` / `INTERNAL` (case-insensitive) — cross-checked
    against the item's `type` field (mismatch is a warning)
  - `sources:`, if present, must be a non-empty list; each source a mapping with a
    non-empty `query` string, or a non-empty `queries` list of strings
  - `parameters:`, if present, must be a list of mappings, each with a string `name`
  - when there is no `sources:` and no top-level `query:`, a (non-blocking)
    warning notes the artifact collects nothing
  - deep VQL compilation of the sources' queries remains authoritative on the
    server, at `artifact_set()` — this only catches YAML-syntax and shape problems
    before that point
- **Client Monitoring / Server Monitoring — artifact-name format check** — every
  event-artifact name in the artifacts list (enabled or not) must match
  Velociraptor's dotted artifact-name format; a malformed name is now a validation
  error (`INVALID_ARTIFACT_NAME`) instead of being silently sent to the server.
  The name-format check is centralised in a new `lib/artifactName.ts`, shared by
  custom-artifacts, client-monitoring and server-monitoring.
- **Users & ACLs — minimum password length** — an authored basic-auth password
  shorter than 8 characters is now rejected (`WEAK_PASSWORD`); SSO users leaving
  the password blank are unaffected. Usernames are left as freeform (plain names,
  emails, or SSO subject identifiers), matching Velociraptor's own leniency.
- **New dependency** — `yaml` (`^2.9.0`), a zero-transitive-dependency YAML 1.2
  parser, vendored the same way `@grpc/grpc-js` already is (declared in
  `dependencies` + present in `node_modules`, since config-type handlers are
  `require()`'d rather than esbuild-bundled).

## 0.3.0 — 2026-08-01

BYOL infrastructure hosting for the Velociraptor server stack.

- **BYOL infrastructure** — provision and manage a dedicated Velociraptor server
  (bring-your-own-license) from an **Infrastructure** page (wraps the SDK
  `ByolInfrastructureManager`): define the topology, deploy to a Veltrix-hosted or
  your own cloud account (BYOC), then run its lifecycle (plan → deploy → destroy,
  start/stop/restart) from the deployment console.
- **node_tiers-native topology** — two user-scalable tiers stored generically in a
  `node_tiers` JSONB column (`[{key,count,placement}]`), no legacy count columns:
  - **Frontend nodes** (`velociraptor-server`) — the Velociraptor server (GUI 8889
    + frontend 8000 + gRPC API 8001), ALB-fronted and horizontally scalable.
  - **Datastore nodes (MinIO)** (`datastore`) — the shared S3/MinIO file+datastore
    backend every frontend reads/writes.
  Plus the fixed foundation (network, load balancer, DNS, TLS, secrets) — see
  `infra/spec.ts` and `lib/byolTopology.ts`.
- **App-owned provisioning + metering** — `/byol` routes derive a Terraform-style
  resource plan from the stack topology, persist it, track deployment runs + steps,
  and emit provisioning events for downstream workers; a lifecycle state log feeds
  daily node-hours usage metering (`/byol/usage`). Tables are `velociraptor_`-owned
  (migrations `002`/`003`).

> The Velociraptor ports (GUI 8889 / frontend 8000 / gRPC API 8001), the GUI
> health-check path, and the MinIO datastore sizing are reasonable defaults —
> verify them against a live Velociraptor deployment before production use.

## 0.2.0 — 2026-08-01

Three new config types, all driven over the same gRPC/mTLS VQL seam.

- **Client Monitoring** config type — manage client event-collection rules per
  client label group (label / event artifacts / enabled). Read via
  `get_client_monitoring()`, applied idempotently by merging the authored groups
  into the ClientEventTable and writing once with `set_client_monitoring()`; the
  "All" label targets every client. Rollback restores the full prior table
  snapshot; drift compares each group's artifact set.
- **Server Monitoring** config type (singleton) — manage the server-wide
  SERVER_EVENT artifact list (artifacts / enabled). Read via
  `get_server_monitoring()`, applied via `set_server_monitoring()`; rollback
  restores the prior table snapshot.
- **Users & ACLs** config type — manage Velociraptor GUI users and their roles
  (name / roles / optional basic-auth password). Upsert by name via
  `user_create(user=, roles=[...], password=)`; read via `gui_users()`; rollback
  deletes users this deploy created or re-grants prior roles via `user_grant()`.
  Unknown roles are warned, not rejected.
- **Shared VQL helpers** (`lib/velociraptorApi.ts`) — `splitList` /
  `vqlStringArray` / `asBool` for turning textarea lists and CSV roles into clean
  VQL. Each config type centralises its own VQL strings + value shapes in its
  `_shared.ts` as a single swap point.

> These VQL functions are real Velociraptor server functions, but the
> client/server monitoring VALUE SHAPE (ClientEventTable / ServerMonitoringTable
> JSON) and the `gui_users()` columns are inferred and flagged in code — verify
> them against a live Velociraptor server before production use.

## 0.1.0 — 2026-07-31

Initial release — foundation + first config type.

- **Custom Artifacts** config type — add / edit / delete Velociraptor custom VQL
  artifacts (name, type, description, artifact YAML) over the gRPC API (mutual
  TLS) by executing VQL, with validate / deploy (upsert by name via
  `artifact_set`) / rollback (restore prior definition or `artifact_delete`) /
  health-check / drift-detect / status.
- **gRPC/mTLS transport** (`lib/velociraptorApi.ts`) — resolves the api-client
  config bundle into CA cert / client cert / client key / connection string,
  builds a mutual-TLS gRPC channel, and runs VQL, all behind a swappable
  transport seam. Wire contract in `lib/velociraptor.proto`.
- **Connectivity test** against the Velociraptor gRPC API (`SELECT * FROM
  info()`) using the api-client config.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (api-client config → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Velociraptor server; saving a connection registers
  `velociraptor-server` as a deploy target).

> The gRPC service/method, SSL target-name override, and VQL function names
> (`artifact_set` / `artifact_delete` / `artifact_definitions` / `info`) are
> flagged in code and should be verified against a live Velociraptor server.
