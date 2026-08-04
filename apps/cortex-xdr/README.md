# Cortex XDR (Veltrix app)

Manage **Palo Alto Networks Cortex XDR** configuration as code through the Cortex
XDR **public REST API** and the newer **Cortex Platform REST API**. Authoring
happens in the Veltrix Configuration Canvas; every write goes through the
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Cortex XDR / Cortex Platform APIs.

## What it manages

| Configuration type | Cortex XDR endpoint(s) | Identity | Write path |
| --- | --- | --- | --- |
| **Threat Indicators (IOCs)** | `indicators/insert_jsons`, `indicators/delete` | Indicator value | Confirmed |
| **Behavioral Indicators (BIOC)** | `bioc/get`, `bioc/insert`, `bioc/delete` | Name | Confirmed |
| **Correlation Rules** | `correlations/get`, `correlations/insert`, `correlations/delete` | Name | Confirmed |
| **Hash Exceptions** | `hash_exceptions/allowlist`, `hash_exceptions/blocklist` | SHA256 hash | Confirmed (add-only) |
| **Endpoint Groups** | `endpoints/get_endpoint_groups` (read) + create/delete | Group name | Read real, write flagged |
| **Legacy Exceptions** | `legacy_exceptions/{fetch,add,edit,delete}` | Name | Confirmed (base license) |
| **Prevention Profiles** | `endpoints/get_profiles` (read) + `profiles/prevention/{add,edit}` | Name | Confirmed (add + edit, no delete) |
| **Agent Configuration Settings** | `configurations/agent/*` (9 GET/SET pairs) | Singleton | Confirmed |
| **Syslog Integrations** | `integrations/syslog/{create,get,update,delete}` | Name | Confirmed (full CRUD) |
| **External Applications** | `platform/integration/v1/external-application` | Name | Confirmed (full CRUD, Cortex Platform API) |
| **Alert Notification Rules** | `platform/notifications/v1/{list-rules,rule,update-rule-status}` | Name | Confirmed (full CRUD, Cortex Platform API) |
| **Alert Exclusions** | `alerts/*` (all speculative) | Rule name | Speculative (no public API) |

The IOCs, BIOC and Correlation Rules types all reconcile by a caller-chosen
identity (indicator value / rule name) against a bulk `insert`-style upsert
endpoint: a single call inserts new items and updates existing ones by their
server-assigned `rule_id` (looked up first via a list/filter read). Rollback
restores prior bodies or deletes what was created.

> **Re-verified against the full Cortex XDR public API (2026-08).** The write
> surface has grown substantially since this app's first two releases —
> **8 new configuration types** were added in v0.3.0 after auditing the current
> "Cortex Platform" API documentation end to end (see **Coverage** below for
> the complete endpoint-by-endpoint classification). **Alert exclusions**
> (suppression) remain the one confirmed gap: Cortex XDR still documents **no**
> public API for that specific console feature — that type ships the authoring
> surface with every endpoint FLAGGED, unchanged from prior releases. Alert
> **routing** (as opposed to suppression) IS fully documented and implemented
> as **Alert Notification Rules**.

> **Endpoint / field verification.** Every new endpoint path, request envelope
> and field name is marked `VERIFY against live Cortex XDR` in the code.
> Confirm them against a live tenant before relying on them in production —
> this audit was performed against Palo Alto's published OpenAPI fragments,
> not a live tenant.

## API & authentication

Cortex XDR exposes a **per-tenant** REST API. The tenant's API FQDN is the
connection endpoint / component hostname, e.g.
`api-yourtenant.xdr.us.paloaltonetworks.com`. Find the FQDN with **Copy URL**
next to a generated key under **Settings > Configurations > API Keys**.

This app talks to **two API families** on the same tenant FQDN, with the same
credential:

- **`/public_api/v1/...`** (the original, RPC-style surface — most config
  types use this): every call is a `POST` whose JSON body wraps its parameters
  in `request_data`, and every response wraps its payload in `reply`:
  - request: `{ "request_data": { ... } }`
  - response: `{ "reply": ... }`
  - A few bulk endpoints (`indicators/insert_jsons`, `bioc/insert`,
    `correlations/insert`) take `request_data` as an **array**.
  - Two endpoints — `profiles/prevention/add` and `profiles/prevention/edit`
    — are a confirmed exception: they take their body **directly, with no
    `request_data` wrapper**. See `config-types/prevention-profiles/_shared.ts`.
- **`/platform/<area>/v1/...`** (the newer "Cortex Platform" surface — External
  Applications and Alert Notification Rules use this): plain REST verbs
  (GET/POST/PUT/PATCH/DELETE) with a bare JSON body, no envelope. See
  `CortexXdrClient.request()` in `lib/cortexXdrApi.ts`. The published docs for
  these endpoints don't re-print the auth headers the way `/public_api/v1`
  fragments do, but the Cortex Platform IAM documentation describes a single
  API-key mechanism (gated by the RBAC permissions attached to the key) for
  the whole platform — this app reuses the same Standard-security headers.
  **VERIFY the exact auth requirement against a live tenant.**

- **Auth (Standard security level):** two headers on every call, on both API
  families —
  - `x-xdr-auth-id: <API Key ID>` (the integer key id)
  - `Authorization: <API Key>` (the key value, sent verbatim — no `Bearer`)
- **Advanced security** keys add a per-request nonce + timestamp + SHA256 HMAC
  signature. Only **Standard** is wired up; the Advanced signing seam is
  stubbed and clearly commented in `lib/cortexXdrApi.ts` as a follow-up.
- **Bad credentials** surface as **HTTP 401 / 403**.

## Setup

1. **API key** — in the Cortex XDR console, **Settings > Configurations > API
   Keys**, create a key with the **Standard** security level and a role scoped to
   what this app manages.
2. **Credential** — store the key as a Veltrix credential: **username** → API Key
   ID, **API Key (token)** → the API Key value.
3. **Component** — register a **`cortex-xdr-tenant`** component whose hostname is
   your tenant API FQDN (Copy URL) and attach the credential. The Connections page
   does both when you save a connection.
4. **Connections** — use the app's Connections page to verify the tenant FQDN +
   key with a live probe (`POST /public_api/v1/endpoints/get_endpoint_groups/`).

## Configuration notes

- **Indicators (IOCs)** — the indicator VALUE is the identity used for upsert and
  drift. `type` is one of `HASH`, `IP`, `DOMAIN_NAME`, `PATH`, `FILENAME`;
  `severity` one of `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`; `reputation` one
  of `GOOD`, `BAD`, `SUSPICIOUS`, `UNKNOWN`; `reliability` an Admiralty grade
  `A`–`F`. `expiration_date` is an optional Unix epoch timestamp in
  **milliseconds** (leave blank for never). All enum values and the expiration
  units are `VERIFY`-flagged against a live tenant.
- **Behavioral Indicators (BIOC)** — the rule NAME is the identity. `type` is a
  MITRE-style behavioral category; `severity` uses a **4-tier** scale
  (`SEV_010_INFO`…`SEV_040_HIGH`, no CRITICAL tier — distinct from IOCs).
  `indicator` is an opaque JSON filter tree (VERIFY the shape against a live
  tenant or by exporting an existing rule). Reconciles by name: list → match →
  `bioc/insert` with the matched `rule_id` to update, or without one to create.
- **Correlation Rules** — the rule NAME is the identity. Runs `xql_query` on a
  schedule (`simple_schedule` / `crontab`) or in real time
  (`execution_mode: REAL_TIME`) and raises an alert on a match. Same 4-tier
  severity scale as BIOC. `suppression_*` fields control duplicate-alert
  collapsing. Reconciles the same way as BIOC.
- **Hash Exceptions (allow / block list)** — the SHA256 `hash` is the identity;
  `list_type` is `allowlist` or `blocklist`; `comment` is optional. Deploy adds
  hashes via the documented `hash_exceptions/allowlist` / `hash_exceptions/blocklist`
  endpoints (hashes sharing a list + comment are submitted together). This API is
  **add-only** — there is no list/remove endpoint — so drift is not asserted and
  rollback cannot auto-remove (it reports what was added for manual removal).
- **Endpoint Groups** — the `name` is the identity; `group_type` is `static` or
  `dynamic`; `filter` is a JSON membership object for dynamic groups. Listing is a
  real endpoint (`endpoints/get_endpoint_groups`, the health probe) so drift +
  health work; create/delete are best-effort against FLAGGED, unverified paths.
- **Legacy Exceptions** — the `name` (`rule_name`) is the identity; `module` is a
  numeric module id (look it up via `legacy_exceptions/get_modules` or the
  console); `platform`/`status`/`scope` are constrained enums; `conditions` is a
  module-specific JSON object (hash/path/signer/command). This is the
  **base-license** equivalent of the newer, Cloud-add-on-gated
  `disable_prevention/*` API (see Coverage) — a full add/edit/delete CRUD.
- **Prevention Profiles** — the `name` is the identity; `profile_type` /
  `platform` are untyped strings on the wire (Cortex's own docs give no enum —
  common values are suggested, warned-not-errored); `modules` is a JSON
  configuration bundle (look up the schema via
  `profiles/prevention/get_modules`). **No delete endpoint is documented** —
  add + edit only. **Default profiles cannot be edited** (a live 400 from
  Cortex, surfaced as a clear deploy error). Read and write use different
  request envelopes on the SAME endpoint family — see the API & authentication
  section above.
- **Agent Configuration Settings** — a **tenant-wide singleton**: declare it at
  most once per canvas. Bundles 9 independent GET/SET setting groups (content
  management/bandwidth, agent status, auto-upgrade, WildFire analysis,
  informative BTP issues, log collection, critical environment versions,
  advanced analysis, endpoint administration cleanup); every deploy re-applies
  every declared boolean/integer value ("owns it outright", the same policy
  the Auth0 app's tenant-settings type uses). `action_center_expiration` is
  different — a genuine **partial-merge** keyvalue map (only the action-type
  keys you list are ever touched); the complete action-type key set is not
  enumerated in Cortex's own docs.
- **Syslog Integrations** — the `name` is the identity (Cortex assigns a
  numeric `syslog_integration_id` on create); `protocol` is `TCP`/`UDP`/`TLS`;
  TLS certificate fields live under `security_info`. A **confirmed full CRUD**
  surface — the cleanest write path this app has. `certificate_content` is
  write-only (never returned by `GET`), so drift is not asserted on it and a
  rollback restore cannot recover a changed certificate.
- **External Applications** — the `name` is the identity (Cortex assigns a
  numeric `application_id` on create); `application_type` is one of
  `syslog`/`webhook`/`splunk`/`aws_sqs`/`aws_s3`; `connection_config` is a
  provider-specific JSON object whose exact shape Cortex's own docs describe
  only as "documented in the respective schemas" without printing them —
  export an existing application from the console as a reference. Reached
  over the **newer Cortex Platform REST API**
  (`platform/integration/v1/external-application`) — different prefix and verb
  style than every other type in this app (see API & authentication above).
  `connection_config` commonly carries provider secrets, so it is not diffed
  for drift.
- **Alert Notification Rules** — the `name` is the identity (Cortex assigns a
  `rule_uuid` on create); `forward_type` is a required string (the complete
  `LogForwardType` enum is not printed inline in Cortex's docs); `filter` is a
  required JSON criteria object; at least one forward channel (email
  distribution list, Slack channels, or a Syslog Integration id) is required.
  `enabled`/`disabled` is applied via a **separate** status endpoint after
  create/update — it is not part of the create/update body per the documented
  schema. `applications` references External Application ids and
  `forward_source.syslog.id` references a Syslog Integration id — both are
  authored as plain identifiers here, not cross-type-resolved. Reached over the
  same Cortex Platform REST API as External Applications.
- **Alert Exclusions** — the `name` is the identity; `filter` is a required JSON
  criteria object; `comment` is optional; `disabled` is a flag. **No public API is
  documented** for alert exclusions — every endpoint is speculative and deploy is
  expected to fail on a current tenant. All fields and endpoints are `VERIFY`-flagged.

## Limitations

- **Standard auth only** (Advanced HMAC signing is a documented seam).
- **Alert exclusions (suppression) remain unimplementable against a real
  endpoint.** Every other configuration type in this app now targets a
  confirmed public API — see Coverage below.
- **`/platform/*` auth is inferred, not directly confirmed.** External
  Applications and Alert Notification Rules reuse this app's Standard API-key
  headers; Cortex's own published fragments for these two endpoint families
  don't show the auth parameters the way `/public_api/v1` fragments do.
- **Rollback / drift reads are best-effort.** Several types (IOCs, BIOC,
  Correlation Rules, Legacy Exceptions) have no simple "list everything"
  endpoint and page through a bounded window (`search_from`/`search_to`); an
  item outside that window won't be matched for drift or rollback. Hash
  Exceptions and (for newly-created items) Prevention Profiles have no
  documented delete/list endpoint at all — see their Configuration notes above.
- Write-only secrets (the API Key, TLS certificate content, external-application
  connection secrets) are never read back, diffed, or stored in rollback
  data / artifacts / logs.
- The app writes only through the Cortex XDR / Cortex Platform APIs; it
  registers no platform-side database tables or background jobs.

## Development

```
cd apps/cortex-xdr
node node_modules/typescript/bin/tsc --noEmit        # typecheck
node ../../scripts/test-apps.mjs cortex-xdr          # run the config-type tests
node ../../scripts/validate-app.mjs apps/cortex-xdr   # (from repo root) manifest + bundle checks
```

## Coverage (v0.3.0)

Coverage was audited against the current Cortex XDR / Cortex Platform API
documentation (`cortex-docs.paloaltonetworks.com/xdr-5-api`, Cortex XDR
5.1/5.2, fetched 2026-08-04) — the same tenant-scoped `/public_api/v1` and
`/platform/*` surface reachable from a `cortex-xdr-tenant` connection's FQDN
and API key. Every endpoint discovered in that documentation is classified
below as **managed** (a config type in this app writes it), or **excluded**
(with the reason).

### Managed declarative configuration

| Configuration type | API operations |
| --- | --- |
| Threat Indicators (IOCs) | `indicators/{insert_jsons,get_changes,delete}` |
| Behavioral Indicators (BIOC) | `bioc/{get,insert,delete}` |
| Correlation Rules | `correlations/{get,insert,delete}` |
| Hash Exceptions | `hash_exceptions/{allowlist,blocklist}` (add-only, no read/delete documented) |
| Endpoint Groups | `endpoints/get_endpoint_groups` (real) + `endpoints/{create,delete}_endpoint_group` (flagged, unverified) |
| Legacy Exceptions | `legacy_exceptions/{fetch,add,edit,delete,get_modules}` |
| Prevention Profiles | `endpoints/get_profiles` (read) + `profiles/prevention/{add,edit,get_modules}` (add/edit only — no delete) |
| Agent Configuration Settings | `configurations/agent/{content_management,agent_status,auto_upgrade,wildfire_analysis,informative_btp_issues,cortex_xdr_log_collection,action_center_expiration,critical_environment_versions,advanced_analysis,endpoint_administration_cleanup}` (+ `/set` on each) |
| Syslog Integrations | `integrations/syslog/{create,get,update,delete}` |
| External Applications | `platform/integration/v1/external-application` (list/create/update/get/delete) |
| Alert Notification Rules | `platform/notifications/v1/{list-rules,rule,update-rule-status}` (list/create/get/update/delete/status) |
| Alert Exclusions | Speculative — no confirmed endpoint (see below) |

Not wired into deploy/healthCheck (confirmed, but a deliberate action, not
steady-state config): `integrations/syslog/test` and
`profiles/add_signer_cn_to_allowlist` fire real side effects (a test syslog
message; a signer-CN append with no matching read-back) rather than converging
declared state, so they are left as manual/console operations.

### Intentionally excluded

- **Cortex Cloud / ASPM / compliance domain, not Cortex XDR EDR.**
  `rule`/`rule/search`/`rule/{id}` ("Detection Rules Management") carries
  `asset_types`, `compliance_metadata` and `compliance_standards` fields — a
  Cloud Security Posture / Application Security surface, not endpoint
  detection. Asset Groups, Asset Inventory, Attack Surface Management, CIEM,
  Cloud Onboarding, Cloud Workload Protection, Compliance Controls, Data
  Security Posture Management, Netscan, Policies (cloud-security), Vulnerability
  Intelligence/Management and ASPM/CI-CD are the same story — all under this
  docs corpus's unified "Cortex Platform" umbrella, none of them Cortex XDR EDR
  capabilities this app's `cortex-xdr-tenant` connection targets.
- **Requires a separate license this app does not assume.** `disable_prevention/*`
  ("Disable Prevention Rule") and `disable_injection_prevention_rules/*`
  ("Disable Injection and Prevention Rules") both explicitly require the
  **Cortex Cloud Posture Management add-on** per Cortex's own docs. The latter
  is also inherently temporary (a 24/48-hour self-expiring exception, not
  durable state). **Legacy Exceptions** — implemented — is the base-license
  equivalent of the same underlying capability (module exceptions).
- **Physical/virtual appliance, foreign resource.** Broker VM management
  (`brokers/*`, actions, applets — WEC/WEF certs, Network Mapper) requires a
  physically- or virtually-installed appliance that self-registers via a
  bootstrap token; a canvas item cannot originate one, only edit/reboot/
  upgrade/deregister something that already exists outside this app's
  ownership boundary — the same reasoning `cisco-meraki` uses to exclude
  device-scale resources.
- **No discovery endpoint / fundamentally a bulk fan-out action.**
  `tags/agents/{assign,create,remove,delete_permanently}` has no "list all tag
  definitions" read, and assign/remove target an endpoint-id filter (a live
  bulk action against physical devices), not a durable named resource.
- **Installer-package lifecycle, not durable posture.**
  `distributions/{create,get_distributions,get_status,get_dist_url,delete}` and
  `distributions/restore` generate/restore downloadable agent installer
  packages (with an `eol_time`) — an artifact-generation workflow, not
  steady-state configuration to reconcile.
- **Security-sensitive IAM / control-plane bootstrap**, the same boundary
  `cisco-meraki` draws around SAML/administrator management:
  `authentication-settings/*` (IdP SSO config), `api_keys/*` (API key
  self-management), and `rbac/*` / `system/get_tenant_info` / `healthcheck`
  ("System Management").
- **Read-only.** `audits/{management_logs,agents_reports}` (Audit Log),
  `device_control/get_violations`, and the bulk of "Endpoint Management":
  `endpoints/{get_endpoints,get_endpoint,get_policy,get_profiles-as-a-generic-
  browse}`, `distributions/get_versions`.
- **Imperative actions on live endpoints, not declarative state.**
  `endpoints/{isolate,unisolate,scan,abort_scan,quarantine,restore,
  file_retrieval,update_agent_name,upgrade}`, `triage_endpoint`,
  `actions/{file_retrieval_details,get_action_status}`,
  `quarantine/status`, `get_triage_presets` ("Response Action"); and
  `scripts/{run_script,run_snippet_code_script,get_script_*}` ("Script
  Execution"). The Scripts **library** itself
  (`scripts/{get,insert,delete}`) stores executable payloads whose only
  consumer is that imperative execution API — not standalone security
  posture — so it is excluded alongside it.
- **Case/issue/managed-services workflow, not configuration.** Cases APIs,
  Issues APIs, Managed Services (assignment/comments/reports/status) are
  ticket/workflow state, not declarative posture.
- **Dataset/query/dashboard platform, not EDR config.** XQL dataset
  management, Lookup Datasets, Query Library, Scheduled Queries, Dashboards,
  Widgets, Playbooks — content-authoring surfaces for the analytics platform,
  outside this app's Cortex XDR EDR scope.

Primary references: [Cortex XDR API overview](https://cortex-docs.paloaltonetworks.com/xdr-5-api),
the per-endpoint OpenAPI fragments linked from each config type's `_shared.ts`,
and `lib/cortexXdrApi.ts` for the two request envelopes this app speaks.
