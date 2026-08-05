# Changelog

All notable changes to the Tenable Vulnerability Management app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.1 — 2026-08-05

### Fixed
- **Profiles hit a non-existent endpoint.** The config type called a bare
  `/profiles`, which does not exist in Tenable's current API — profiles live
  at `/sensors/profiles/{sensor_type}` (`agent` | `scanners`; see
  [profiles-create](https://developer.tenable.com/reference/profiles-create)).
  Added a required **Sensor Type** field, switched every handler to the real
  path, and fixed the request body to nest tuning settings under `config`
  (previously spread onto the top level) with a new optional **Description**
  field. Matching/dedupe is now scoped to (sensor type, name), since an agent
  profile and a scanner profile may share a name.
- **Recast Rules used a `GET` that has no `GET` method, and the wrong filter
  shape.** Listing now uses `POST /v1/recast/rules/search` (there is no plain
  `GET /v1/recast/rules`). The `filter` field is now the API's real
  `{"and"|"or": [{"property","operator","value"}]}` shape — the previous flat
  `{plugin_id, host_targets}` object could never match Tenable's schema. The
  rule's name is now actually sent as `rule_name` (previously silently
  dropped) and rules match live state by name instead of a synthetic tuple.
  Added support for Host Audit rules (`CHANGE_RESULT`/`ACCEPT_RESULT` with
  `compliance_result`) alongside the existing Vulnerability/Web-App family
  (`RECAST`/`ACCEPT` with `severity`) — action/resource-type compatibility is
  now validated, mirroring the Permissions config type's existing
  object/action compatibility check. Severity values are corrected to
  Tenable's real, case-sensitive enum (`NONE`/`LOW`/`MEDIUM`/`HIGH`/
  `CRITICAL` — not the previous lowercase `info`/`low`/…). Added `comment`,
  `false_positive` and `disabled`/`disabled_reason` (pause a rule without
  deleting it), all real fields the old model omitted entirely.
- **Policies called `PUT /policies/{id}/configure`.** That literal path
  segment does not exist on the live API — confirmed against pyTenable's
  `PoliciesAPI.configure()`, which calls plain `PUT /policies/{id}`; the
  method name mirrors the *reference page title*, not the URL. Fixed in
  `deploy.ts` and `rollback.ts`.

All three were found by auditing every endpoint this app calls against
Tenable's officially published OpenAPI catalog
(`developer.tenable.com/openapi/vulnerability-management.json` and
`.../tenable-platform-settings.json`) instead of prose docs alone — see the
README's Coverage section for the full audit and the endpoints deliberately
left unmanaged.

## 1.3.0 — 2026-07-22

### Added
- **Drift attribution ("who changed it + when").** When a configuration drifts
  from its deployed state, every drift now carries a best-effort `actor` —
  resolved from the Tenable **Audit Log** (`GET /audit-log/v1/events`) by
  correlating recent events to the drifted object by target id/name. The last
  change (create/update/delete) wins, falling back to the most recent event;
  the mapped actor records the name/email, when it happened, and the action.
  Attribution is **strictly best-effort**: it never throws, never blocks a drift
  check, and yields nothing when the audit log is inaccessible (it needs an
  admin API key and returns 403 otherwise), empty, or uncorrelated. The Veltrix
  connection identity is excluded so our own deploys are never mis-attributed as
  a manual change. Wired into all 18 configuration types' drift detection.

### Changed
- Grouped the **Configurations** sidebar into 7 collapsible sections — Scanning,
  Assets, Credentials & Connectors, Organization, Agents, Findings, and Access
  Control — so all 18 configuration types stay navigable. Sections collapse by
  default, remember whether you left them open, and always expand the one you're
  currently working in.
