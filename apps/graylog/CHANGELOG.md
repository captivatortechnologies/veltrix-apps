# Changelog

All notable changes to the Graylog app are documented here.

## 0.2.0 — 2026-08-01

Three new config types (wave 2) — all upsert by title, with validate / deploy /
rollback / health-check / drift-detect / status and the mandatory `X-Requested-By`
CSRF header on every write.

- **Inputs** config type — create / edit / delete Graylog message inputs (title,
  type, global flag, node, configuration JSON) over the Graylog REST API
  (`/api/system/inputs`). Note: on read Graylog returns an input's configuration
  under `attributes` (not `configuration`); drift compares only declared keys to
  avoid false positives from server-defaulted values.
- **Pipeline Rules** config type — create / edit / delete processing pipeline rules
  (title, description, rule DSL source) over `/api/system/pipelines/rule`. Graylog
  names the rule from the DSL (`rule "NAME"`), so validation enforces that the item
  title matches the rule name; drift compares the whitespace-normalized source.
- **Index Sets** config type — create / edit / delete index sets (title, index
  prefix, rotation and retention strategy, shards/replicas) over
  `/api/system/indices/index_sets`. The handler fills the many required boilerplate
  fields (index analyzer, index optimization, writable, field-type refresh) with
  sensible defaults and sets `use_legacy_rotation: true` so the chosen
  rotation/retention strategies are authoritative. Rotation supports message-count
  / size / time (ISO-8601 period); retention supports delete / close / no-op.
- Shared handler helpers (`lib/handlerHelpers.ts`, `lib/coerce.ts`) — health
  (`GET /api/system`) and status are identical for every Graylog config type, so
  they are defined once and re-exported by each type.

> **API verification.** Endpoints, request/response shapes and required fields were
> checked against the graylog2-server source (release 6.1): `InputsResource` /
> `InputCreateRequest` / `InputSummary`, `RuleResource` / `RuleSource`,
> `IndexSetsResource` / `IndexSetSummary` and the rotation/retention strategy
> configs. Two version-dependent points to re-verify on the target instance:
> the pipeline-rule path is `/api/system/pipelines/rule` for modern bundled Graylog
> (older external plugin builds used
> `/api/plugins/org.graylog.plugins.pipelineprocessor/system/pipelines/rule`), and
> `use_legacy_rotation` selects the classic index rotation model over data tiering.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Streams** config type — create / edit / resume / delete Graylog message streams
  (title, description, matching type, remove-from-default-stream, index set, rules)
  over the Graylog REST API (`/api/streams`), with validate / deploy (upsert by
  stream title, resume newly created streams) / rollback (restore prior body or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the Graylog REST API (`GET /api/system`, HTTP Basic,
  self-signed TLS tolerated) using a Graylog user or an access token.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (credential → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Graylog node; saving a connection registers `graylog`
  as a deploy target).

> Graylog REST API paths (`/api/system`, `/api/streams`, `/api/streams/{id}`,
> `/api/streams/{id}/resume`, `/api/system/indices/index_sets`) should be verified
> against a live Graylog instance. Every write carries the mandatory
> `X-Requested-By` CSRF header. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.
>
> **BYOL hosting** for the Graylog stack (Graylog server + OpenSearch/Elasticsearch
> + MongoDB) is planned for a later wave and is intentionally not part of this
> release — no database or infrastructure provisioning ships yet.
