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

22 config types across six sidebar groups (Data Pipelines, Integrations,
Knowledge, Packs, Security, Worker Groups). See **Coverage** below for the
full list, the exact REST operations behind each, and what was deliberately
left out.

Every group-scoped type resolves its target Worker Group / Edge Fleet per item
from the item's `worker_group` field, falling back to the app's **Default
Worker Group** setting (`default`); set that blank for a single-instance
deployment. A handful of collections (Notification Targets, Notifications) are
NOT Worker-Group-scoped at all — Cribl exposes them as a single global list.

## Connectivity

The **Connections** page pairs a Cribl endpoint (component) with a login/token
credential and runs a per-row test: obtain a Bearer, then
`GET /api/v1/system/info`. On-prem Leaders serve the API on `9000` (configurable
via `cribl_api_port`); Cribl.Cloud is on `443`.

## Coverage (v0.3.0)

Coverage was audited against the official Cribl OpenAPI spec (v4.14.0, as
vendored inside the official `criblio/terraform-provider-criblio` — the same
spec that backs `docs.cribl.io/cribl-as-code/api-reference/`), cross-checked
against that provider's own `docs/resources/*.md` for field-naming, current as
of 2026-08-04.

### Managed declarative configuration

| Configuration type | REST surface | Identity |
| --- | --- | --- |
| Pipelines | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/pipelines[/<id>]` | id |
| Routes | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/routes[/<id>]` (singleton, id `default`) | table id |
| Sources | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/inputs[/<id>]` | id |
| Destinations | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/outputs[/<id>]` | id |
| Lookups | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/lookups[/<id>]` | filename-shaped id |
| Regexes | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/regex[/<id>]` | id |
| Grok Patterns | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/grok[/<id>]` | id |
| Parsers | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/parsers[/<id>]` | id |
| Event Breakers | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/breakers[/<id>]` | id |
| Schemas | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/schemas[/<id>]` | id |
| Global Variables | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/vars[/<id>]` | id |
| Subscriptions | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/subscriptions[/<id>]` | id |
| Collectors | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/jobs[/<id>]` | id (conf as JSON — discriminated ~9-backend body) |
| Notification Targets | `GET`/`POST`/`PATCH`/`DELETE /api/v1/notification-targets[/<id>]` (NOT group-scoped) | id |
| Notifications | `GET`/`POST`/`PATCH`/`DELETE /api/v1/notifications[/<id>]` (NOT group-scoped; `group` is a body field) | id |
| Database Connections | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/database-connections[/<id>]` | id |
| Packs | `GET`/`POST /api/v1[/m/<group>]/packs`, `PATCH` (query-string upgrade)/`DELETE .../<id>` | id (installs from a git/registry `source`, not a local file) |
| Secrets | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/secrets[/<id>]` | id |
| Certificates | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/certificates[/<id>]` | id |
| Keys | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/system/keys[/<id>]` | `keyId` (metadata only — no `plainKey`/`cipherKey`) |
| HMAC Functions | `GET`/`POST`/`PATCH`/`DELETE /api/v1[/m/<group>]/lib/hmac-functions[/<id>]` | id |
| Worker Group Settings | `GET`/`PATCH /api/v1/m/<group>/system/settings/conf` (singleton, no create/delete) | Worker Group |

Every list-shaped type upserts by its identity: create (`POST`) when new,
update (`PATCH /…/<id>`) when it already exists; deploy snapshots the prior
object so rollback can restore it, or delete one it created. Routes and Worker
Group Settings are per-group SINGLETONS instead — Cribl has exactly one of
each per Worker Group, so there is nothing to create, only to PATCH.

**Write-only secret fields** — Secrets' `value`/`password`/`apiKey`/
`secretKey`, Certificates' `privKey`/`passphrase`, and Database Connections'
`connectionString`/`password`/`configObj` are never echoed back by Cribl. Each
is sent only when its canvas field is non-blank (validate warns, never
errors, when it's empty — matching `apps/cisco-ise`'s internal-users password
convention), is never captured into rollbackData, and is never drift-checked.
Rollback for these types deletes a newly-created record but leaves an UPDATED
one as-is (its prior secret was never captured to restore).

**Global Variables' `encryptedString` type** is a documented exception to
normal drift/rollback: Cribl encrypts that one value server-side, so it may
not round-trip on GET the way every other Global Variable type does. Every
other type (string/number/boolean/array/object/expression/any) is fully
diffed and restorable.

### Intentionally excluded

- **RBAC — Roles, Policies, Teams, Users** (`/system/roles`, `/system/policies`,
  `/system/teams`, `/system/users`) — real, documented on-prem endpoints, but
  the official `criblio/terraform-provider-criblio` — written by Cribl, with
  full access to these same OpenAPI schemas — excludes all four from its own
  resource coverage. This app follows that precedent: a Role/Policy edit can
  break the very credential this app authenticates with mid-deploy, and
  `Team.ssoGroupIds` confirms membership is commonly federated from an
  external IdP in the deployments this platform targets, not locally declared.
- **Worker Group provisioning** (`Group` resource — `/master/groups`,
  `/products/{product}/groups`) — creating/deleting the Worker Group or Edge
  Fleet itself is topology/infrastructure provisioning (this app's
  `worker_group` item field already assumes the group exists), not day-to-day
  configuration. "Worker-groups config" is covered instead by **Worker Group
  Settings** (`system/settings/conf`), which genuinely is a per-group
  configuration singleton.
- **Commit / Deploy** (`/version/commit`, `/master/groups/{id}/deploy`, the
  per-project `version/commit` variants) — imperative git-commit-and-push
  ACTIONS, not durable desired state. This app's own validate → deploy →
  rollback pipeline, run per resource, is the code-managed equivalent of
  Cribl's commit+deploy cycle.
- **Parquet Schemas** (`lib/parquet-schemas`) — near-identical to Schemas
  (JSON Schema) but scoped narrowly to typing Parquet destination output.
  Excluded for scope, not principle; a natural follow-up alongside Schemas.
- **Pack install via local `.crbl` file upload** (`filename` param on
  `POST`/`PUT /packs`) — uploads a file already present on the Cribl box's own
  filesystem; not reachable over this app's plain JSON REST transport. Packs
  instead uses the declarative `source` + `spec` (git URL or registry
  reference, optionally pinned to a branch/tag/semver) install path, which IS
  plain REST.
- **Raw key material for Keys** (`plainKey` / `cipherKey` on
  `KeyMetadataEntity`) — both are optional fields that would let a caller
  supply literal key bytes over the wire. Never sent, so Cribl's local KMS
  always generates the material server-side — mirrors the official Terraform
  provider's own omission of these two fields, and keeps Key management
  entirely metadata-only (algorithm, KMS, rotation), with nothing secret ever
  passing through this config type.
- **Search / Cribl Lake resources** (`search-*`, `products/lake/*`,
  `default_search` group paths) — a different Cribl PRODUCT (Cribl Search /
  Cribl Lake), not Stream configuration; out of this app's scope.
- **Events, metrics, logs, samples, jobs (search/executor), processes,
  licenses, diagnostics** — read-only telemetry or one-shot imperative
  actions, not durable desired state a canvas can own.

Primary references: the Cribl OpenAPI spec (v4.14.0) vendored in
[`criblio/terraform-provider-criblio`](https://github.com/criblio/terraform-provider-criblio)
(`openapi.yml`), that provider's [resource docs](https://github.com/criblio/terraform-provider-criblio/tree/main/docs/resources),
and [docs.cribl.io/cribl-as-code](https://docs.cribl.io/cribl-as-code/api-reference/).

## Notes

> Cribl REST API paths (`/api/v1/auth/login`, `/api/v1/m/<group>/pipelines`,
> `/api/v1/system/info`) and the pipeline JSON shape (`{ id, conf: { functions } }`)
> follow the documented Cribl API
> ([auth](https://docs.cribl.io/cribl-as-code/api-auth/),
> [API](https://docs.cribl.io/cribl-as-code/api/)) and should be **verified
> against a live Cribl**. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.

Apache-2.0.
