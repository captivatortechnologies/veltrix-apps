# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-07-26

### Added
- Initial release. IBM QRadar REST API client (`lib/qradar.ts`) with `SEC`
  authorized-service-token auth, the required `Version` header, and the classic
  reference-data set operations (create / get / add value / delete value /
  delete set).
- **Reference Sets** configuration type — manage QRadar reference sets (named,
  typed value collections) as code, with the full pipeline handler set: validate,
  deploy, rollback, drift detection, health check and status. Sets are matched by
  name; their values are reconciled to exactly the declared list (add missing,
  remove extra); the element type is immutable, so a same-name set of a different
  type is not modified; reconcile only deletes sets this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the SEC-token credential and the `ibm-qradar` deploy target.
- Connection test (`handlers/testConnection.ts`) listing the reference-data sets.
