# Changelog

All notable changes to the Cortex XDR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added — re-verified the full Cortex XDR public API and closed the gap

Re-audited the Cortex XDR public API end to end against the current "Cortex
Platform" documentation (cortex-docs.paloaltonetworks.com/xdr-5-api, Cortex XDR
5.1/5.2). The write surface has grown substantially since 0.2.0 — 8 new,
genuinely-declarative configuration types were found and added, all reachable
from the existing `cortex-xdr-tenant` connection:

- **Behavioral Indicators (BIOC)** (`config-types/biocs`) — a CONFIRMED
  get/insert/delete-by-filter surface (`bioc/get`, `bioc/insert`,
  `bioc/delete`), the same shape as Threat Indicators. Reconciles by name.
- **Correlation Rules** (`config-types/correlation-rules`) — XQL-based
  detections, the same get/insert/delete shape as BIOC
  (`correlations/get`, `/insert`, `/delete`).
- **Legacy Exceptions** (`config-types/legacy-exceptions`) — prevention-module
  exception rules via `legacy_exceptions/{fetch,add,edit,delete}`, a full CRUD,
  BASE-LICENSE surface — the unrestricted equivalent of the newer
  `disable_prevention/*` API, which requires the Cortex Cloud Posture
  Management add-on and is intentionally NOT implemented (see Coverage).
- **Prevention Profiles** (`config-types/prevention-profiles`) — the agent
  security POLICY surface: named module-configuration bundles, read via
  `endpoints/get_profiles` and written via `profiles/prevention/{add,edit}`.
  These two write endpoints send their body RAW — no `{ request_data }`
  wrapper, unlike every other endpoint in this app. No delete endpoint is
  documented (add + edit only, the same honesty as Hash Exceptions).
- **Agent Configuration Settings** (`config-types/agent-configuration-settings`)
  — a tenant-wide singleton bundling 9 confirmed GET/SET setting pairs
  (`configurations/agent/*`: content management/bandwidth, agent lifecycle,
  WildFire analysis, BTP display, log collection, critical environment
  versions, advanced analysis, endpoint administration cleanup) plus one
  genuine partial-merge keyvalue map (action center expiration).
- **Syslog Integrations** (`config-types/syslog-integrations`) — a CONFIRMED
  full CRUD surface (`integrations/syslog/{create,get,update,delete}`) for
  syslog forwarding destinations.
- **External Applications** (`config-types/external-applications`) — webhook /
  Splunk / AWS SQS / AWS S3 / Syslog routing targets, a CONFIRMED full CRUD
  surface over the newer Cortex Platform REST API
  (`platform/integration/v1/external-application`) — a different prefix and
  plain REST verbs (GET/POST/PUT/DELETE), not the `/public_api/v1` RPC style
  the rest of this app uses.
- **Alert Notification Rules** (`config-types/alert-notification-rules`) —
  alert routing (email/Slack/Syslog/external applications), a CONFIRMED full
  CRUD surface over `platform/notifications/v1`. This is DIFFERENT from the
  existing (still-speculative) Alert Exclusions type: exclusions SUPPRESS
  alerts and have no documented public API; notification rules ROUTE alerts
  that already fired and are fully documented.
- **`lib/cortexXdrApi.ts`**: added `CortexXdrClient.request()`, a generic
  REST-verb method for the `/platform/*` endpoint family (External
  Applications, Alert Notification Rules) alongside the existing
  `/public_api/v1` RPC-style `call`/`post`. Existing methods are unchanged.
- **`lib/fields.ts`**: shared canvas-field readers (ported from
  `apps/auth0/lib/fields.ts`) used by the new types.
- Full handler set (validate / deploy / rollback / healthCheck / driftDetect /
  getStatus) for each new type, registered in `pipeline.configurationTypes`,
  plus 178 total tests (52 existing + 126 new).

### Notes — re-verification also confirmed several surfaces are genuinely out of scope

- **Detection Rules Management** (`/public_api/v1/rule*`) is Cortex Cloud /
  ASPM / compliance domain (asset_types, compliance_metadata,
  compliance_standards fields) — not Cortex XDR EDR. Excluded.
- **Disable Prevention Rule** and **Disable Injection and Prevention Rules**
  both require the **Cortex Cloud Posture Management add-on** license per
  Cortex's own docs, and the latter is also an inherently temporary
  (24-48h self-expiring) exception, not durable declarative state. Excluded —
  Legacy Exceptions is the base-license-eligible equivalent that IS
  implemented.
- **Broker VM** (tenant + on-appliance) and its **Applets** are physical/
  virtual-appliance resources whose provisioning is a bootstrap registration
  token, not something a canvas item originates — the same reasoning
  `cisco-meraki` uses to exclude device-scale resources. Excluded.
- **Tags** (`tags/agents/{assign,create,remove,delete_permanently}`) have no
  list-of-definitions endpoint and their primary use (assign/remove) is a
  per-endpoint-filter fan-out action, not a durable named resource. Excluded.
- **Distributions** / **Restore Distributions** are installer-package
  generation/lifecycle actions (with an `eol_time`), not durable declarative
  posture. Excluded.
- Authentication Settings, API Keys and System Management/RBAC are
  security-sensitive IAM bootstrap; Audit Log, Device Control violations and
  the bulk of the Endpoint Management read surface are read-only; Response
  Action, Script Execution and the Scripts library are imperative
  (isolate/scan/quarantine/run) rather than declarative. All excluded — see
  the README Coverage section for the complete endpoint-by-endpoint audit.
- Every new endpoint path, request envelope, field name and enum value is
  marked `VERIFY against live Cortex XDR` in the code — confirm against a live
  tenant before production use. The `/platform/*` auth requirement (same
  Standard/Advanced API key as `/public_api/v1`, per the Cortex Platform IAM
  docs) is inferred, not directly confirmed with an explicit header example.

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
