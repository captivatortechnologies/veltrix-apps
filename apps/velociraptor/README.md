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

The artifact name is the stable identity used to upsert (add vs update) and to
detect drift; deploy snapshots the prior definition YAML so rollback can restore
it (or delete an artifact it created).

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

## Notes

The gRPC service/method (`proto.API` / server-streaming `Query`), the SSL
target-name override, and the VQL function names (`artifact_set`,
`artifact_delete`, `artifact_definitions`, `info`) are flagged in the code and
should be **verified against a live Velociraptor server**. See the `VERIFY`
comments in `lib/velociraptor.proto` and `lib/velociraptorApi.ts`.

Apache-2.0.
