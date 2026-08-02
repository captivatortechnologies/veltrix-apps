# Changelog

All notable changes to the Velociraptor app are documented here.

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
