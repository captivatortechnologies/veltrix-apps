# Changelog

All notable changes to the Cortex XDR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-01

### Added

- **Hash Exceptions (allow / block list)** configuration type
  (`config-types/hash-exceptions`) — the second **confirmed** public-API write
  surface. Deploy adds SHA256 file hashes to the tenant allow list or block list
  via `POST /public_api/v1/hash_exceptions/allowlist/` and
  `.../hash_exceptions/blocklist/` (hashes are batched by list + comment).
  Fields: `hash` (SHA256, identity), `list_type` (`allowlist`/`blocklist`),
  `comment`.
- **Endpoint Groups** configuration type (`config-types/endpoint-groups`) —
  static or dynamic (filter-based) groups, upserted by `name`. Drift + health
  read from the **real** `POST /public_api/v1/endpoints/get_endpoint_groups/`
  endpoint. Fields: `name` (identity), `description`, `group_type`
  (`static`/`dynamic`), `filter` (JSON).
- **Alert Exclusions** configuration type (`config-types/alert-exclusions`) —
  suppression rules with `name` (identity), `filter` (JSON), `comment` and a
  `disabled` flag, upserted by `name`.
- Full handler set (validate / deploy / rollback / healthCheck / driftDetect /
  getStatus) for each new type, registered in `pipeline.configurationTypes`, plus
  new tests (existing 16 + 36 new = 52 total).

### Notes — Cortex XDR public API is limited for config writes (be honest)

- **IOCs** (0.1.0) and **hash exceptions** are the only surfaces with a
  **confirmed** public write path. Hash exceptions are **add-only**: Cortex XDR
  documents no endpoint to **list** or **remove** them, so their drift is not
  asserted and rollback **cannot auto-remove** — it reports the added hashes and
  asks for manual console removal.
- **Endpoint groups** — **listing is real** (`get_endpoint_groups`, also the
  health probe) so drift + health are genuine, but **create / delete are NOT
  documented** in the public API. Deploy / rollback attempt FLAGGED
  (`/endpoints/create_endpoint_group/`, `/endpoints/delete_endpoint_group/`)
  paths best-effort and will likely 404 on a live tenant.
- **Alert exclusions** — the Cortex XDR public API documents **no** alert-exclusion
  management at all (console-only feature). Every endpoint in this type is
  **speculative / FLAGGED** (`/alerts/get_alert_exclusions/`,
  `.../create_alert_exclusion/`, `.../delete_alert_exclusion/`); the type ships
  the authoring + pipeline surface ready for a future API, but deploy is
  best-effort and expected to fail today. It was kept (rather than dropped) to
  provide the authoring surface, with every path loudly flagged — **do not treat
  its endpoints as real**.
- The originally-scoped **scoring-rules / alert-starring** surface was **dropped**
  in favour of **hash exceptions**: the Cortex XDR public API exposes no scoring /
  starring write path, whereas hash exceptions have a documented one.
- Every endpoint path, request envelope, field name and enum value added here is
  marked `VERIFY against live Cortex XDR` in the code — confirm against a live
  tenant before production use.

## 0.1.0 — 2026-07-31

### Added

- **Initial foundation** for managing Palo Alto Networks Cortex XDR configuration
  as code over the Cortex XDR public REST API. Config-as-code only — no database,
  no infrastructure provisioning.
- **Cortex XDR REST client** (`lib/cortexXdrApi.ts`): POSTs the
  `{ request_data }` envelope, unwraps `{ reply }`, and signs every request with
  **Standard**-security auth headers (`x-xdr-auth-id` + `Authorization`). Includes
  a connectivity/health probe and a clearly-commented seam for **Advanced**
  (nonce + timestamp + SHA256 HMAC) auth as a follow-up.
- **Threat Indicators (IOCs)** configuration type (`config-types/iocs`) with the
  full handler set — validate, deploy, rollback, healthCheck, driftDetect,
  getStatus — plus a canvas covering indicator value, type
  (`HASH`/`IP`/`DOMAIN_NAME`/`PATH`/`FILENAME`), severity
  (`INFO`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), reputation
  (`GOOD`/`BAD`/`SUSPICIOUS`/`UNKNOWN`), reliability (`A`–`F`), comment and an
  optional epoch-millis expiration. Deploy upserts by indicator value via
  `POST /indicators/insert_jsons/`; rollback restores prior bodies or deletes
  created indicators via `POST /indicators/delete/`.
- **Connections** page (`cortex-xdr-tenant` component) + a `testConnection`
  handler that probes `POST /public_api/v1/endpoints/get_endpoint_groups/`, and
  **Overview** + **Setup Guide** pages.

### Notes

- The exact indicator endpoint paths, request envelopes, field names and enum
  values are marked `VERIFY against live Cortex XDR` in the code — confirm them
  against a live tenant before production use.
