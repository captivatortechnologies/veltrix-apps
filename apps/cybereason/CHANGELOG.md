# Changelog

All notable changes to the Cybereason app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and
[semantic versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added

Exhaustion pass over the Cybereason REST API surface: re-verified every prior
DROP and added the write paths that turned out to be genuinely declarative and
round-trippable.

- **Sensor Policies** configuration type (`config-types/sensor-policies`) —
  Cybereason's prevention/detection policy (anti-malware, anti-exploit,
  anti-ransomware, application control, PowerShell protection, the behavioral
  rules engine, VPP, collection features, ...), upserted **by name**. Deploy
  reads the live policies (`GET /rest/policies`), then `PUT
  /rest/policies/{id}` when a policy of that name exists or `POST
  /rest/policies` otherwise; rollback restores the prior `configuration` or
  `DELETE /rest/policies/{id}?assignToPolicyId=…` (reassigning sensors to the
  tenant's default policy, resolved by scanning policy detail for
  `metadata.isDefault` — there is no fixed sentinel GUID here the way Groups
  has `00000000-…`). The huge, deeply-nested configuration schema is authored
  as one JSON blob (`configuration`) — following Cisco Meraki's Group
  Policies / Singleton-settings precedent — with the typed `name` /
  `description` / `notes` fields always winning over the same keys in the
  blob; only a small set of well-known, live-tenant-confirmed enum fields
  (anti-malware detect/prevent mode, anti-exploit mode, ARW mode/level,
  rules-engine mode) are validated, and drift recursively compares every key
  actually **declared** in the blob against live, at any nesting depth
  (`diffDeclaredKeys`), not a fixed whitelist. Full handler set + tests.
  - **List / get / create / delete are CONFIRMED** — cross-referenced against
    `forensic-security/cybereason` (async Python SDK) `sensors.py` POLICIES
    region, AND against that same repo's `tests/schemas/sensors.yaml`
    `policies` JSON Schema, which is checked by a **live-tenant integration
    test** (`test_get_policies`) — i.e. every field name/enum documented in
    `_shared.ts` is drawn from a REAL recorded tenant response, not guessed.
  - **FLAGGED / UNVERIFIED — updating an existing policy** (`PUT
    /rest/policies/{id}`). Neither the Python SDK above nor the
    actively-maintained Cortex XSOAR Cybereason integration
    (`demisto/content`, which has zero policy-related commands) implement a
    policy update call, and Cybereason's own API docs
    (`nest.cybereason.com`, `api-doc.cybereason.com`) require a customer
    login and could not be independently checked. PUT is inferred **only** by
    symmetry with the Groups resource on the same tenant, which shares an
    identical list/create/get-by-id/delete-with-reassignment shape and DOES
    have a confirmed `PUT /rest/groups/{id}`. `deploy.ts` attempts the PUT and
    surfaces a specific, actionable failure — never a silent no-op — if a
    tenant rejects it. `validate.ts` also emits a standing
    `POLICY_UPDATE_UNVERIFIED` warning so this is visible to whoever approves
    the deploy. **Verify this against a live Cybereason tenant before relying
    on updates in production.**
- **Sensor Tags** configuration type (`config-types/sensor-tags`) — per-sensor
  metadata tags (department, location, device type, critical asset, custom
  tags), identified by the sensor's `pylumId`. Deploy reads the sensor's
  current tags (`POST /rest/sensors/query` filtered by `pylumId` — the exact
  field set, incl. the read-side `deviceType`/`criticalAsset`/`customTags`
  names, is drawn from the SAME live-tenant-recorded schema as Sensor
  Policies above) then applies `POST /rest/tagging/process_tags`, a
  per-tag `SET` (value present) / `REMOVE` (field left blank) upsert —
  reproducing the API's literal, space-containing wire tag names
  (`"device type"`, `"critical asset"`, `"custom tags"`) verbatim. Rollback
  restores the prior snapshot per tag (`SET` back, or `REMOVE` a tag that had
  none before). **CONFIRMED** end-to-end in `forensic-security/cybereason`
  `sensors.py` (`set_sensor_tags`, `get_sensors`). Full handler set + tests.
- Registered both types in `pipeline.configurationTypes` and added
  `sensor-policies` + `sensor-tags` app permissions.

### Notes — re-evaluated the app's prior scope (honest, not exhaustive-by-default)

- **Custom Detection Rules — RE-CONFIRMED DROPPED.** Re-checked against the
  same sources used for this pass (the Python SDK's `rules.py` custom-rules
  region is unchanged: `create_custom_rule`/`update_custom_rule` still forward
  an opaque, un-typed `data` blob). Still a nested Element → Feature → filter
  graph requiring catalog-sourced enums, not a flat round-trippable object —
  stays dropped for the same reason as the 0.2.0 release.
- **Custom reputations for domains/IPs — ALREADY COVERED.** The existing
  `reputations` config type already supports `keyType: domain` and `keyType:
  ipv4` alongside file hashes (see `config-types/reputations/canvas.yaml`) —
  re-verified, no gap here.
- **An alternate, newer reputations surface exists and was investigated —
  NOT added.** `dynamic/v1/ti-reputation/api/v1/lists/{listId}/reputations`
  (list/update, with per-group scoping + expiry) is a different, newer
  reputations mechanism from the `classification/update` API this app already
  ships. It was left out: it would duplicate the already-shipped, well-
  confirmed `reputations` type; the Python SDK's own equivalent list-method is
  commented out by its author; and its create path (an `id`-keyed `update`
  with no visible `create`) is not clearly round-trippable from public
  sources.
- **Exclusion / allow rules — NOT a separate surface.** File/process/registry
  exclusions (`antiMalware.exclusions`, `antiExploit.antiExploitExclusions`,
  `rulesEngine.pathExclusions`, `powershellProtection.*Exclusions`) are
  authored **inside** a Sensor Policy's `configuration` JSON — there is no
  separate global exclusions endpoint to wrap.
- **Response / remediation policy — covered via Sensor Policies.** The
  per-policy fully-automated-response toggle (`configuration.response.enabled`)
  is authored the same way, inside the JSON blob. Actual remediation
  ACTIONS (kill process, quarantine file, isolate/unisolate) remain
  imperative operations, not durable desired state, and stay out of scope —
  consistent with isolation/unisolation already being excluded.
- **Users / roles — investigated, DROPPED.** Cybereason's public clients only
  expose **read-only** user endpoints (`GET /rest/users`, `GET
  /rest/users/{username}`) plus a self-service `update_password`
  (credential rotation for the CURRENT session, not user/role management).
  No create/update/delete-user or role-assignment endpoint was found in any
  source checked. Even if one existed, platform user/role administration is
  security-sensitive identity bootstrap, not canvas configuration — the same
  reasoning Cisco Meraki's Coverage notes apply to credential/SAML
  administration.
- **Notification config — investigated, DROPPED.** `GET
  /rest/settings/configurations` ("get details on settings updates including
  Malop notification settings") is a **read-only audit/change-log feed**, not
  a live settings object with a write counterpart — no notification/syslog/
  webhook/SMTP write endpoint was found in any source checked.
- **Malop labels** (`detection/labels`, `add-label`, `labels/delete`) — a
  create/delete-only triage-taxonomy catalog for alerts, not prevention/
  detection configuration. Considered and left out as a lower-value, out-of-
  category surface for this app; may revisit if a future pass targets
  alert-triage workflow as-code.

## 0.2.0 — 2026-08-01

### Added

- **Sensor Groups** configuration type (`config-types/sensor-groups`) — manage
  Cybereason sensor groups (name, description, assigned `policyId`, optional
  dynamic `groupAssignRule`) as code, upserted **by name**. Deploy reads the live
  groups (`GET /rest/groups`), then `PUT /rest/groups/{id}` when a group of that
  name exists or `POST /rest/groups` otherwise; rollback restores the prior body
  or `DELETE /rest/groups/{id}?assignToGroupId=…` (reassigning sensors to the
  Unassigned group). Full handler set + tests.
- **Isolation Rules** configuration type (`config-types/isolation-rules`) — manage
  Cybereason isolation (exception) rules (IPv4 `ipAddressString`, `direction`
  `ALL`/`INCOMING`/`OUTGOING`, optional `port` where `0` = any, `blocking` flag).
  The **composite** `ip + direction + port` is the upsert identity (Cybereason
  assigns the server-side `ruleId`). Deploy reads the live rules
  (`GET /rest/settings/isolation-rule`), then `PUT` (carrying the live rule's
  `ruleId` + `lastUpdated` concurrency token) or `POST` to create; rollback
  re-reads live state to reconcile the fresh token, then restores prior values or
  `POST .../isolation-rule/delete`. Full handler set + tests.
- App session client (`lib/cybereasonApi.ts`) gained `putJson` + `del` helpers on
  the authenticated session so the new types can `PUT`/`DELETE` alongside the
  existing `get`/`postJson`.
- Registered both types in `pipeline.configurationTypes` and added
  `sensor-groups` + `isolation-rules` app permissions.

### Notes — honest scope (Cybereason write API is limited beyond reputations)

- **Sensor Groups** and **Isolation Rules** are **confirmed writable** — every
  endpoint (list + create + update + delete) was cross-checked against **two
  independent, real Cybereason clients**: the `forensic-security/cybereason`
  Python SDK (`sensors.py`, `rules.py`) and the `tobor88` PoshCybereason
  PowerShell module. The endpoint strings match verbatim across both.
- **FLAGGED** items to verify against a live tenant: the inner schema of a sensor
  group's dynamic `groupAssignRule` (passed through as opaque JSON — validated
  only for JSON validity), and the exact list-response envelopes + the isolation
  `lastUpdated` optimistic-concurrency semantics. All are marked `VERIFY` /
  `FLAGGED` in the code.
- **Custom Detection Rules was researched and DROPPED.** The endpoints exist
  (`GET /rest/customRules/decisionFeature/live|deleted`,
  `POST /rest/customRules/decisionFeature/create|update`, with a `/rest/v2/…`
  split on newer tenants), but a valid create/update body is a **nested
  Element → Feature → filter graph** requiring correct `elementType` /
  `facetName` / `connectionFeature` values plus `malopDetectionType` /
  `malopActivityType` / `rootCause` enums pulled from separate catalog endpoints —
  not a flat, round-trippable config object, and the official docs warn a bad rule
  can harm retention/performance. It is **not realistically maintainable as
  declarative config from public sources**, so it was dropped rather than shipped
  as a misleading best-effort surface (cf. the Cortex XDR precedent of dropping
  surfaces without a genuine as-code write path).

## 0.1.0 — 2026-08-01

Initial foundation release.

- New Veltrix app **Cybereason** (category **EDR**) managing the Cybereason
  Defense Platform over its REST API.
- Session-cookie access seam (`lib/cybereasonApi.ts`): username / password login
  to `/login.html` → `JSESSIONID` cookie, replayed on every `/rest/...` call.
- **Custom Reputations** configuration type — allowlist / blocklist entries for
  file hashes (MD5 / SHA-1), domains and IPv4 addresses, with a full pipeline:
  validate, deploy (upsert by key via `POST /rest/classification/update`),
  rollback (restore prior verdict or remove), health check, drift detection
  (against `GET /rest/classification/download`) and status.
- Connection-level connectivity test (`handlers/testConnection.ts`): session
  login + a bounded authenticated read.
- Client pages: Overview, Setup Guide, Connections.
