# 📊 Graylog

Manage [Graylog](https://www.graylog.org) — the open-source SIEM / log-management
platform — as code on the Veltrix Security-as-Code platform. Author configuration
in the Configuration Canvas and drive it through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status).

## How it's managed

Graylog exposes a single, uniform **REST API** under `<host>/api/`. This app applies
configuration over that API:

- **HTTP Basic auth** — every request carries an `Authorization: Basic` header. Two
  equivalent credential forms are supported:
  - a **user**: `username:password`
  - an **access token**: the token as the username with the literal password
    `token` (`<token>:token`) — the recommended form.
- **`X-Requested-By` CSRF guard** — Graylog rejects any non-GET request (create /
  update / delete) that lacks this header, so every write sends it automatically.
- **Self-signed TLS tolerated** — a self-hosted Graylog behind a self-signed
  certificate is accepted; the transport is protocol-aware (http/https), and the
  default REST port is 9000.

See **Coverage** below for the full list of configuration types this app manages.

### Streams — an example: identity, rules and index-set resolution

The stream **title** is the stable identity used to upsert (create vs update) and
to detect drift. A newly created stream is **resumed** (Graylog creates streams
paused). Deploy snapshots the prior stream body so rollback can restore it — or
delete a stream it created.

**Rules** are authored as a JSON array of `{ field, type, value, inverted }`. The
rule `type` is an integer (from Graylog's `StreamRuleType`):

| type | meaning | needs a value? |
|---|---|---|
| 1 | match exactly | yes |
| 2 | match regular expression | yes |
| 3 | greater than | yes |
| 4 | smaller than | yes |
| 5 | field presence | no |
| 6 | contains | yes |
| 7 | always match | no |
| 8 | match input | yes |

`index_set_id` is required by Graylog to create a stream; leave the canvas field
blank and the deploy resolves the instance's **default** index set
(`GET /api/system/indices/index_sets`). Several other types follow this same
"resolve a friendlier name/title to the id Graylog actually wants" convention —
Pipeline Connections (stream/pipeline titles), Lookup Tables (cache/data-adapter
names), Extractors (input title) and Sidecar Configurations (collector name).

## Authentication

Store a Veltrix credential with either:

- a Graylog **user**: `username` + `password`, or
- a Graylog **access token** (recommended): the token as `apiToken`

Register a `graylog` (or `standalone`) component pointing at the Graylog REST API
host, then pair it with the credential on the **Connections** page.

## BYOL infrastructure hosting

Bring-your-own-license **infrastructure hosting** for the full Graylog stack
(Graylog server + OpenSearch + MongoDB) ships from the **Infrastructure** console
(`/byol`) — provision, plan, deploy, monitor and destroy a dedicated stack, with
node-hours usage metering. See `CHANGELOG.md` (0.3.0) for the full feature list;
stack sizing / ports should be verified against current Graylog deployment
guidance (docs.graylog.org) before treating them as production-grade.

## Notes

Every Graylog REST API path, request/response shape and required field used by
this app is cited in the `Source:` comment at the top of each configuration
type's `_shared.ts` (checked against the graylog2-server source, release 6.1).
TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting; the REST port defaults to 9000 and is configurable via
`graylog_port`.

## Development

```
cd apps/graylog
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs graylog          # run handler tests
node ../../scripts/validate-app.mjs apps/graylog  # validate against the app contract
node ../../scripts/dataflow/generate.mjs graylog  # regenerate DATAFLOW.md
```

## Coverage (v0.4.0)

Coverage was audited against the graylog2-server source (release 6.1) — the REST
resource classes cited in each configuration type's `_shared.ts` — rather than
against Graylog's own (frequently incomplete) REST API browser docs.

### Managed declarative configuration

| Configuration type | Graylog REST API operations |
| --- | --- |
| Streams | `GET`/`POST` `/streams`, `PUT`/`DELETE`/resume `/streams/{id}` |
| Inputs | `GET`/`POST` `/system/inputs`, `PUT`/`DELETE` `/system/inputs/{id}` |
| Extractors | `GET`/`POST` `/system/inputs/{inputId}/extractors`, `PUT`/`DELETE` `.../extractors/{id}` |
| Grok Patterns | `GET`/`POST` `/system/grok`, `PUT`/`DELETE` `/system/grok/{id}` |
| Pipeline Rules | `GET`/`POST` `/system/pipelines/rule`, `PUT`/`DELETE` `/system/pipelines/rule/{id}` |
| Pipelines | `GET`/`POST` `/system/pipelines/pipeline`, `PUT`/`DELETE` `/system/pipelines/pipeline/{id}` |
| Pipeline Connections | `GET` `/system/pipelines/connections/{streamId}`, `POST` `/system/pipelines/connections/to_stream` (whole-value replace) |
| Index Sets | `GET`/`POST` `/system/indices/index_sets`, `PUT`/`DELETE` `/system/indices/index_sets/{id}` |
| Lookup Caches | `GET`/`POST` `/system/lookup/caches`, `PUT`/`DELETE` `/system/lookup/caches/{idOrName}` |
| Lookup Data Adapters | `GET`/`POST` `/system/lookup/adapters`, `PUT`/`DELETE` `/system/lookup/adapters/{idOrName}` |
| Lookup Tables | `GET`/`POST` `/system/lookup/tables`, `PUT`/`DELETE` `/system/lookup/tables/{idOrName}` |
| Event Definitions | `GET`/`POST` `/events/definitions`, `PUT`/`DELETE` `/events/definitions/{id}` |
| Notifications | `GET`/`POST` `/events/notifications`, `PUT`/`DELETE` `/events/notifications/{id}` |
| Roles | `GET`/`POST` `/roles`, `PUT`/`DELETE` `/roles/{name}` |
| Sidecar Collectors | `GET`/`POST` `/sidecar/collectors`, `PUT`/`DELETE` `/sidecar/collectors/{id}` |
| Sidecar Configurations | `GET`/`POST` `/sidecar/configurations`, `GET`/`PUT`/`DELETE` `/sidecar/configurations/{id}` |
| Outputs | `GET`/`POST` `/system/outputs`, `PUT`/`DELETE` `/system/outputs/{id}` |
| Decorators | `GET`/`POST` `/search/decorators`, `PUT`/`DELETE` `/search/decorators/{id}` |

Plus **BYOL infrastructure hosting** — see the section above (not a configuration
type; an app-owned provisioning console).

Every type upserts by a stable identity (title/name, or a documented pair —
Extractors by (input, title); Sidecar Collectors by (name, OS); Decorators by
(stream, type)), captures the prior live state in `rollbackData` before writing,
and re-derives its own health/status from the shared `graylogSystemHealthCheck` /
`graylogConfigStatus` handlers (`GET /api/system`).

### Intentionally excluded

- **Legacy Stream Alert Conditions** (`/streams/{id}/alerts/conditions`) and
  **Alarm Callbacks** — the pre-6.x alerting model, superseded by Event
  Definitions + Notifications (both covered above). Managing a deprecated,
  soon-removed API surface would give operators a false sense of durability.
- **Stream Rules as a standalone type** — already fully covered by the Streams
  type's own `rules` field (`PUT /streams/{id}` replaces the whole rule list in
  one call); a separate type would let two config types race to own the same
  underlying array.
- **Dashboards / Views** (`/dashboards`, `/views/search`) — a composite
  Search+View object model with generated, cross-referential widget/query ids
  that must stay internally consistent. Flattening it into a single declarative
  canvas item risks silently corrupting a saved dashboard; excluded until a
  safe composite model can be designed.
- **Output-to-stream assignment** (`POST`/`DELETE` `/streams/{id}/outputs`) —
  Graylog's own output-UPDATE endpoint strips `streams` from every request
  body, so there is no single idempotent write that both defines an output AND
  its stream attachment together. The Outputs type manages the output's own
  definition; wire it to a stream from the Graylog UI (or a future dedicated
  assignment type).
- **Sidecar per-host state** (`/sidecar/sidecars`, registrations, "Sidecar is
  active/collector running") is live agent telemetry, not desired
  configuration.
- **Content Packs, Roles' built-in `Admin`/`Reader`, Users, Auth Services,
  API tokens, Cluster/Node administration** (rotate certs, remove nodes,
  restart, notifications-dismiss, message processing pause) are either
  security-sensitive control-plane bootstrap outside this app's connection
  boundary, or imperative operations rather than durable desired state.
- **Search, Messages, Views' Saved Searches, Export Jobs, Field Types,
  Suggestions, Favorites, Start Page** and other `views`/`search` endpoints are
  read/query surfaces, not configuration.
- **Metrics, Cluster health, System jobs, Notifications (system, not event),
  Debug/thread-dump, License** are runtime/monitoring reads, not declarative
  config.

Primary references: the graylog2-server source at
[Graylog2/graylog2-server](https://github.com/Graylog2/graylog2-server) (release
6.1) and each REST resource class cited in the `Source:` comment of every
configuration type's `_shared.ts`.

Apache-2.0.
