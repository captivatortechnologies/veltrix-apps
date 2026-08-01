# Changelog

All notable changes to the Orca Security app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
