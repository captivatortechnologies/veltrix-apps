# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-08-02

### Added

- Initial release. Illumio Core (PCE) REST API v2 client (`lib/illumioApi.ts`)
  with HTTP Basic auth (API key + secret), a self-signed-tolerant `node:https`
  transport gated by the `verify_tls` setting, and org-scoped path helpers.
- **Labels** configuration type — manage Illumio Core labels (key/value policy
  objects under the `role` / `app` / `env` / `loc` built-in dimensions, or a
  custom dimension already created in the PCE) as code, with the full pipeline
  handler set: validate, deploy, rollback, drift detection, health check and
  status. Labels are matched by their **(key, value) pair** — the PCE's own
  identity for a label, since `key` is immutable after create — and created
  where missing; optional `external_data_set` / `external_data_reference`
  integration metadata is synced on labels that already exist. Reconcile only
  deletes labels this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared
  `<ConnectionsManager>` configured for the API key + secret credential and the
  `illumio-pce` deploy target.
- Connection test (`handlers/testConnection.ts`) verifying the PCE host/port/
  organization ID settings and the API key credential with a single
  `GET /orgs/{org_id}/labels?max_results=1`.

### Deferred

- Security policy (rule sets, rules, services, IP lists, enforcement
  boundaries) — the PCE's draft-then-provision model needs its own pipeline
  shape and is planned for a follow-up release.
- Custom label dimensions (`label_dimensions` API, PCE 22.5+) — not yet
  managed; `key` must reference an existing dimension.
