# Changelog

All notable changes to the Orca Security app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added

Seven new configuration types, completing a full exhaustion pass over Orca's
config-as-code write surface (research-first, verified against the official
`orcasecurity/terraform-provider-orcasecurity` provider source — see each
type's `_shared.ts` header for citations). See README **Coverage** for the
full managed-vs-excluded breakdown.

- **Custom Compliance Frameworks (`custom-compliance-frameworks`).** Author
  Orca custom compliance frameworks as code via `POST/PUT/GET/DELETE
  /api/compliance/frameworks/{id}` — a named framework of sections, each
  containing tests (controls) mapping an existing Orca rule id to a control
  identifier. Orca's read endpoint never returns section/test data
  (write-only), so drift compares name/description only and rollback restores
  from this app's own last-declared body rather than a live read — an
  honestly-documented limitation, matching the official provider's own
  behavior.
- **Alert Exceptions (`alert-exceptions`).** Declare the enabled/disabled state
  of a BUILT-IN Orca system (catalog) alert as code via
  `PUT /api/sonar/rules/status/{rule_id}`. System alerts cannot be created or
  deleted — only toggled — so identity is the caller-supplied `rule_id` from
  the Orca Alert Catalog, a genuinely different reconciliation shape from
  every other type in this app (no server-assigned id, no delete branch).
- **Discovery Alerts (`discovery-alerts`).** Author Orca discovery-based
  custom alerts as code via the same `/api/sonar/rules` base resource as
  Custom Alerts, but driven by a Discovery (graph) JSON query (`rule_json`)
  instead of a Sonar (DSL) string, with an optional compliance-framework
  association. Verified differences from Custom Alerts: no enabled/disabled
  flag on this payload, and `remediation_text` lives behind a second,
  separately-keyed API this app does not manage (see Coverage).
- **Notification Integrations (`notification-integrations`).** Author Jira
  Cloud, Slack and generic/vendor webhook notification integrations as code
  via `/api/external_service/config`, one config type with a `service`
  selector. Unlike every other type here, identity resolves LIVE by
  `(service, template_name)` — Orca's own lookup key — rather than only from
  this app's rollbackData. Honors a verified per-service PUT quirk: Jira/Slack
  reject a `business_units` change on update (create-time only in this app);
  webhook accepts it.
- **Custom Tag Rules (`custom-tag-rules`).** Author Orca custom tag rules as
  code via `/api/custom_tags` — automatically apply tags to every asset
  matching a Sonar (string) or discovery (JSON) query.
- **Custom Roles (`custom-roles`).** Author Orca custom RBAC roles as code via
  `/api/rbac/roles` — a named set of permission groups a user or group can be
  assigned. Manages role definitions only, not assignment (see Coverage for
  why role/user/group assignment is out of scope).
- **Trusted Cloud Accounts (`trusted-cloud-accounts`).** Author Orca trusted
  cloud accounts as code via `/api/organization/trusted_accounts` — note the
  id travels as a query parameter on every operation but create, and GET
  returns an array envelope even for a single-id lookup, both verified quirks
  this type's `_shared.ts` documents and handles explicitly.
- **`lib/reconcile.ts`** gained `readKeyValueMap`/`stringMapsEqual` (for
  Custom Tag Rules' `tags` field), reusing the same generic, network-free
  helper pattern as the rest of the shared library.
- All seven new types ship the full handler set — `validate`, `deploy`,
  `rollback`, `healthCheck`, `driftDetect`, `getStatus` — with unit tests, and
  are registered in `manifest.pipeline.configurationTypes` and
  `permissions.app`, grouped into three new sidebar groups (Compliance,
  Integrations, Access) alongside the existing Alerts/Organization groups.

## 0.2.0 — 2026-08-01

### Added
- **Business Units (`business-units`).** Author Orca business units as code via
  the filters API — `POST /api/filters`, `PUT /api/filters/{id}`,
  `GET /api/filters/{id}`, `DELETE /api/filters/{id}`. A unit scopes resources by
  one filter type (cloud providers, cloud accounts/vendor IDs, custom tags, cloud
  tags or cloud account tags) plus criticality, owner team, application, contact
  emails and deployment stages. Endpoints verified against the Orca Terraform
  provider (`api_client/business_unit.go`); note the resource lives under
  `/api/filters`, not `/api/business_units`.
- **Automations (`automations`).** Author Orca automations as code via
  `POST /api/automations`, `PUT /api/automations/{id}`,
  `GET /api/automations/{id}`, `DELETE /api/automations/{id}`. Each automation
  pairs a Sonar query (authored as JSON, matching the official provider) with a
  JSON action list, a status (`enabled`/`disabled`) and optional business-unit
  scope. Automations expose a genuine list endpoint
  (`GET /api/automations?limit=&start_at_index=`), so a first deploy also resolves
  identity by name to update — not duplicate — an automation created out of band.
- **Discovery Views (`discovery-views`).** Author saved Orca discovery
  (inventory) queries as code via `POST /api/user_preferences`,
  `PUT /api/user_preferences/{id}`, `GET /api/user_preferences/{id}`,
  `DELETE /api/user_preferences/{id}`. Each view stores a Discovery query
  (`filter_data.query2`), optional display params and an org-level sharing flag.
- **Shared reconciliation library (`lib/reconcile.ts`).** Generic, network-free
  helpers (envelope unwrap, server-id tracking + rollback-read, JSON-field
  parsing, canonical-JSON drift compare) reused by the new config types, keeping
  the "identity is the id we assign and persist in `rollbackData`" pattern DRY.
- All three new types ship the full handler set — `validate`, `deploy`,
  `rollback`, `healthCheck`, `driftDetect`, `getStatus` — with unit tests, and
  are registered in `manifest.pipeline.configurationTypes` and `permissions.app`.

## 0.1.0 — 2026-08-01

### Added
- **Initial foundation release.** Manage Orca Security (agentless CNAPP / CSPM)
  configuration as code through the Orca REST API, driven by the Veltrix
  Security-as-Code pipeline.
- **Custom Alerts (`custom-alerts`).** Author Orca custom alerts (custom Sonar
  rules) as code — a Sonar (DSL) query plus its category, risk score, context
  score and enabled state — via `POST /api/sonar/rules`, `PUT /api/sonar/rules/{id}`,
  `GET /api/sonar/rules/{id}` and `DELETE /api/sonar/rules/{id}`. Because Orca
  publishes no "list custom rules" endpoint, reconciliation uses the `rule_id`
  this app assigns on create and persists in `rollbackData`, matched by the stable
  canvas item id (supporting rename) then by name. Rollback deletes created rules
  and restores the prior body of updated rules.
- **Connections + connectivity test.** API-token authentication
  (`Authorization: Token …`) against the tenant's regional Orca API endpoint
  (default `https://api.orcasecurity.io`; EU `https://api.eu.orcasecurity.io`),
  verified with `GET /api/alerts/catalog/category`.
- Overview, Setup Guide and Connections client pages; `validate`, `deploy`,
  `rollback`, `healthCheck`, `driftDetect` and `getStatus` handlers.
