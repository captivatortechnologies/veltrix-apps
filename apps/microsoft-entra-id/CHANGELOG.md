# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Microsoft Graph API client (`lib/graph.ts`) with OAuth2
  client-credentials auth, token caching, `@odata.nextLink` pagination and 429
  retry.
- **Named Locations** configuration type — manage Conditional Access named
  locations (IP CIDR ranges and country/region lists) as code, with the full
  pipeline handler set: validate, deploy, rollback, drift detection, health
  check and status.
- Connection test (`handlers/testConnection.ts`) that verifies the
  app-registration credential end to end via `GET /organization`.
