# 🦖 Velociraptor

Manage [Velociraptor](https://docs.velociraptor.app) — the open-source endpoint
DFIR / hunting platform — as code on the Veltrix Security-as-Code platform. Author
custom VQL artifacts in the Configuration Canvas and drive them through the
pipeline (validate → deploy → rollback → health-check → drift-detect → status).

## How it's managed

Velociraptor's programmatic API is **gRPC over mutual TLS** — there is no REST
surface. **Management is VQL** executed over that gRPC channel:

- **gRPC + mTLS** — the app runs VQL against the server. The credential is the
  **api-client config** produced by `velociraptor config api_client`, a YAML/PEM
  bundle carrying `ca_certificate`, `client_cert`, `client_private_key` and
  `api_connection_string` (host:port).
- **Config-as-code via VQL** — custom artifacts are upserted with
  `artifact_set(definition=<yaml>)`, listed with `artifact_definitions()`, and
  removed with `artifact_delete(name=<name>)`. Connectivity is probed with
  `SELECT * FROM info()`.

### Credential mapping

The whole api-client YAML bundle is stored as **one connection secret**. The
Connections page labels the secret field **"API client config"** — paste the
entire `velociraptor config api_client` output there. `lib/velociraptorApi.ts`
(`resolveApiClientConfig`) parses the bundle into the four mTLS pieces and reads
it from either the credential's `certificate` or `apiToken` field (whichever the
platform persists), falling back to the connection endpoint for the address, and
also honoring a split-field layout (certificate = client cert, apiToken = client
key, password = CA cert).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Custom Artifacts** | gRPC VQL (`artifact_set` / `artifact_definitions` / `artifact_delete`) | ✅ v0.1.0 |
| **Client Monitoring** | gRPC VQL (`get_client_monitoring` / `set_client_monitoring`) | ✅ v0.2.0 |
| **Server Monitoring** | gRPC VQL (`get_server_monitoring` / `set_server_monitoring`) | ✅ v0.2.0 |
| **Users & ACLs** | gRPC VQL (`user_create` / `user_grant` / `user_delete` / `gui_users`) | ✅ v0.2.0, custom ACL policy v0.4.0 |
| **Secrets** | gRPC VQL (`secret_add` / `secret_modify` / `secrets`) | ✅ v0.4.0 |
| **Client Labels** | gRPC VQL (`label` / `clients`) | ✅ v0.4.0 |
| **Server Metadata** | gRPC VQL (`server_metadata` / `server_set_metadata`) | ✅ v0.4.0 |
| **Third-Party Tools** | gRPC VQL (`inventory_add` / `inventory`) | ✅ v0.4.0 |

The artifact name (Custom Artifacts), label (Client/Monitoring groups), username
(Users & ACLs), secret name (Secrets), label (Client Labels), key (Server
Metadata) and tool name (Third-Party Tools) are each the stable identity used to
upsert (add vs update) and to detect drift; deploy snapshots enough prior state
for rollback to restore it (or delete/reverse what it created) — see each
type's `_shared.ts` for the exact snapshot shape, and Coverage below for the two
structural limitations (secret content, tool removal) that rollback cannot
fully undo.

## BYOL infrastructure

The **Infrastructure** page (wraps the SDK `ByolInfrastructureManager`) provisions
and manages a dedicated Velociraptor server stack (bring-your-own-license) over
this app's app-owned `/byol` routes. The stack is **node_tiers-native**: two
user-scalable tiers are stored generically in a `node_tiers` JSONB column
(`[{key,count,placement}]`), with no legacy count columns.

| Tier (key) | Component kind | Role |
|---|---|---|
| **Frontend nodes** (`frontend`) | `velociraptor-server` | Velociraptor server: GUI (8889) + frontend (8000) + gRPC API (8001), ALB-fronted, scales horizontally |
| **Datastore nodes (MinIO)** (`datastore`) | `datastore` | Shared S3/MinIO file+datastore backend every frontend reads/writes |

`infra/spec.ts` declares the stack (the two roles above plus an all-in-one
`standalone`) as a declarative `InfraSpec` composed from the generic OpenTofu
modules — no tool-specific HCL. `lib/byolTopology.ts` derives the resource plan
by tier key; `lib/byolInput.ts` validates the per-tier minimums; the app-owned
tables (`velociraptor_byol_*`, migrations `002`/`003`) persist the record,
resource plan, deployment runs and daily node-hours usage. The generic
provisioning worker runs `infra/bringup/velociraptor-setup.mjs` after `tofu
apply`, gating readiness on the Velociraptor GUI + frontend.

## Transport seam

The gRPC/proto transport is isolated in `lib/velociraptorApi.ts` behind a small,
swappable interface (`VelociraptorTransport`), lazily loading `@grpc/grpc-js` +
`@grpc/proto-loader` only on the code path that talks to the server. The wire
contract lives in `lib/velociraptor.proto` (the single swap point) — dropping in
Velociraptor's canonical `api.proto` is a drop-in replacement there. Everything
above the seam (config parsing, VQL builders, row parsing) is pure and tested.

> `@grpc/grpc-js` and `@grpc/proto-loader` are declared as runtime dependencies
> and must be bundled/vendored with the app — the platform only guarantees
> `@veltrixsecops/app-sdk` at runtime.

## Coverage (v0.4.0)

Coverage was audited against the public Velociraptor VQL source
(`vql/server/*` — `labels.go`, `inventory.go`, and the `clients/`, `users/`,
`secrets/`, `hunts/`, `notebooks/`, `timelines/`, `favorites/`, `orgs/`,
`monitoring/` packages — [Velocidex/velociraptor](https://github.com/Velocidex/velociraptor))
and `acls/acls.go` / `acls/roles.go` on 2026-08-04, to exhaust the genuinely
**declarative, round-trippable** config-as-code surface reachable over the
gRPC/VQL API this app uses (there is no REST surface — see "How it's managed").

### Managed declarative configuration

| Configuration type | VQL surface |
| --- | --- |
| Custom Artifacts | `artifact_set` / `artifact_definitions` / `artifact_delete` |
| Client Monitoring | `get_client_monitoring` / `set_client_monitoring` |
| Server Monitoring | `get_server_monitoring` / `set_server_monitoring` |
| Users & ACLs (roles + custom permissions) | `user_create` / `user_grant` (roles AND `policy={...}`) / `user_delete` / `gui_users` |
| Secrets (definitions + grants) | `secret_add` / `secret_modify` / `secrets` |
| Client Labels (explicit membership) | `label` / `clients(search='label:...')` |
| Server Metadata (free-form tags) | `server_metadata` / `server_set_metadata` |
| Third-Party Tools (version/URL/hash pins) | `inventory_add` / `inventory` / `inventory_get` |

Every type upserts by a stable identity (artifact name, label, username,
secret name, tool name, or a fixed singleton scope) and snapshots enough prior
state for rollback — see "Configuration types" above.

**Two structural, honestly-flagged limitations** (not implementation
shortcuts — the underlying Velociraptor API has no other option):

- **Secrets — content is write-only.** `secret_add()`'s payload is never
  returned by `secrets()` (metadata only: name/type/grantees), so a secret's
  stored VALUE cannot be diffed for drift or restored on rollback — only its
  grants (users/orgs/visibility) round-trip. Same limitation this app already
  accepts for an authored basic-auth password in Users & ACLs.
- **Third-Party Tools — no delete.** `vql/server/inventory.go` exposes
  `inventory_add` / `inventory_get` / `inventory` only; there is no
  `inventory_delete`/`inventory_remove` plugin. Rollback can restore a tool's
  prior version/URL/hash, but a tool this deploy newly added cannot be
  un-added — the rollback result says so explicitly rather than reporting a
  false "reverted."

### Intentionally excluded — DFIR/investigation actions, not desired state

Velociraptor is a **DFIR runtime**, not a policy engine — most of its
server-side VQL surface beyond the table above is an ACTION with a side
effect that changes every time it runs, not a resource with a stable identity
a canvas can own and reconcile:

- **Hunts** (`vql/server/hunts/{create,delete,stop,info}.go`) — `hunt()`
  generates a **brand-new distinct hunt id on every call**, even with
  identical parameters (verified in source: repeated calls are not
  idempotent). A hunt is a one-shot collection dispatch against clients
  matching a condition at launch time, not a resource with a stable identity
  to upsert or diff — it is fundamentally the same "action, not durable state"
  class this monorepo's other apps exclude (e.g. Cisco Meraki's Live
  Tools/firmware actions).
- **Notebooks** (`vql/server/notebooks/{create,delete,get,list,update}.go`) —
  `notebook_create()` allocates a **new NotebookId on every call**, even with
  an identical name (verified in source) — an investigation workspace, not a
  named, re-appliable resource. (NOTEBOOK-type reusable notebook *templates*
  ARE covered: they're authored as a Custom Artifact with `type: NOTEBOOK`,
  which IS idempotent via `artifact_set`.)
- **Timelines** (`vql/server/timelines/{create,delete,reader}.go`) and
  **Favorites** (`vql/server/favorites/{create,delete,list}.go`) — timelines
  are notebook-scoped analysis artifacts built from a specific investigation's
  query results; favorites (`favorites_save`) are a saved collection shortcut
  stored under the calling analyst's own user profile. Both are per-
  investigation / per-analyst work product, not org-owned desired state with a
  meaningful "canvas owns this" boundary.
- **Client Metadata** (`vql/server/clients/metadata.go`,
  `client_metadata`/`client_set_metadata`) — real free-form per-CLIENT
  key/value data (the same primitive Server Metadata uses, just scoped to one
  endpoint instead of the server). Excluded for the same device-scale reason
  Cisco Meraki excludes port-level settings: it fans out per-endpoint with no
  Veltrix component model for individual Velociraptor clients. Client Labels
  (above) covers the adjacent, bounded, canvas-appropriate case — pinning a
  named label to an explicit, operator-authored client-id list.
- **Multi-org management** (`vql/server/orgs/{create,current,delete}.go`,
  `org_create`/`org_delete`) — tenant/org provisioning for a multi-org
  Velociraptor deployment is control-plane bootstrap outside this app's
  single-connection ownership boundary (Secrets' and Users & ACLs' `orgs`
  arguments target orgs by id, but do not create them).
- **Mail/SMTP server config** — no VQL plugin sets the server's email/SMTP
  configuration; it lives in the server's static `server.config.yaml`, not the
  gRPC/VQL surface this app manages. (An SMTP credential a NOTIFICATION
  artifact reads at runtime, however, fits the Secrets config type above.)
- **Everything action/read-only already excluded before this pass**:
  `client_metadata` (see above), backup/restore (`vql/server/backup.go`),
  Elastic/Splunk/ADX output integrations (one-way exporters, not Velociraptor
  config), and org-agnostic read-only introspection.

Primary references: [VQL Reference](https://docs.velociraptor.app/vql_reference/),
[Velocidex/velociraptor](https://github.com/Velocidex/velociraptor) source
(`vql/server/`, `acls/`), and the `VERIFY` comments in each config type's
`_shared.ts`.

## Notes

The gRPC service/method (`proto.API` / server-streaming `Query`), the SSL
target-name override, and the VQL function names (`artifact_set`,
`artifact_delete`, `artifact_definitions`, `info`, `label`, `server_metadata`,
`server_set_metadata`, `secret_add`, `secret_modify`, `secrets`,
`inventory_add`, `inventory`, and `user_grant`'s `policy` argument) are flagged
in the code and should be **verified against a live Velociraptor server**. See
the `VERIFY` comments in `lib/velociraptor.proto`, `lib/velociraptorApi.ts`, and
each config type's `_shared.ts`.

Apache-2.0.
