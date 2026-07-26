# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-07-26

### Added
- Initial release. SailPoint Identity Security Cloud (ISC) API client
  (`lib/isc.ts`) with OAuth2 client-credentials auth, token caching, offset/limit
  pagination and 429 retry.
- **Transforms** configuration type — manage ISC transforms (name, operation
  type, type-specific JSON attributes) as code, with the full pipeline handler
  set: validate, deploy, rollback, drift detection, health check and status.
  Transforms are matched by their immutable name; built-in (internal) transforms
  are protected and a same-name transform of a different type is never silently
  replaced.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the ISC client-credentials credential (Client ID + Client
  Secret) and the `sailpoint-tenant` deploy target.
- Connection test (`handlers/testConnection.ts`) verifying the OAuth token
  exchange + `GET /transforms/v1`.
