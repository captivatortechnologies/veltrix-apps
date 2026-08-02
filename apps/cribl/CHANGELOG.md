# Changelog

All notable changes to the Cribl app are documented here.

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
