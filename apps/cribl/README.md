# 🐐 Cribl

Manage [Cribl Stream](https://cribl.io) — the telemetry / observability data
pipeline — as code on the Veltrix Security-as-Code platform. Author pipeline
configuration in the Configuration Canvas and drive it through the pipeline
(validate → deploy → rollback → health-check → drift-detect → status).

Cribl Stream is config-as-code by nature: a pipeline is an id plus an ordered
chain of **Functions**. This app applies that configuration over the Cribl REST
API.

## How it's managed

Cribl exposes a uniform **REST API** rooted at `<host>/api/v1`. This app applies
configuration over that API:

- **HTTPS REST** — pipelines via `/api/v1[/m/<group>]/pipelines`. Group-scoped
  resources live under `/m/<group>` (the Worker Group or Edge Fleet); a
  single-instance (non-distributed) deployment omits that segment.
- **Auth** — two credential shapes are supported:
  - **On-prem Leader** — a Cribl **username + password**, exchanged at
    `POST /api/v1/auth/login` for a `{ token }`, then carried as
    `Authorization: Bearer <token>`.
  - **Cribl.Cloud / direct** — a pre-obtained **Bearer token** (e.g. from the
    OAuth client-credentials exchange at `login.cribl.cloud/oauth/token`), stored
    as the connection credential's token and carried verbatim as
    `Authorization: Bearer <token>`.
- On-prem Cribl commonly ships a **self-signed certificate**, which the transport
  tolerates (configurable via the `verify_tls` setting).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Pipelines** | Cribl REST API (`/api/v1[/m/<group>]/pipelines`, `.../<id>`) | ✅ v0.1.0 |

A pipeline pairs a stable `id` with a `conf` JSON block whose `functions` array is
the ordered Function chain. The id is the stable identity used to upsert (POST
create vs `PATCH .../<id>` update) and to detect drift; deploy snapshots the prior
pipeline so rollback can restore it (or delete one it created).

The target Worker Group / Edge Fleet is resolved per pipeline from the item's
`worker_group` field, falling back to the app's **Default Worker Group** setting
(`default`); set that blank for a single-instance deployment.

## Connectivity

The **Connections** page pairs a Cribl endpoint (component) with a login/token
credential and runs a per-row test: obtain a Bearer, then
`GET /api/v1/system/info`. On-prem Leaders serve the API on `9000` (configurable
via `cribl_api_port`); Cribl.Cloud is on `443`.

## Notes

> Cribl REST API paths (`/api/v1/auth/login`, `/api/v1/m/<group>/pipelines`,
> `/api/v1/system/info`) and the pipeline JSON shape (`{ id, conf: { functions } }`)
> follow the documented Cribl API
> ([auth](https://docs.cribl.io/cribl-as-code/api-auth/),
> [API](https://docs.cribl.io/cribl-as-code/api/)) and should be **verified
> against a live Cribl**. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.

Apache-2.0.
