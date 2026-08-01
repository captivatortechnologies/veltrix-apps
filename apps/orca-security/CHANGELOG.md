# Changelog

All notable changes to the Orca Security app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
