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
