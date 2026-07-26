# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.4.0 — 2026-07-26

### Added
- **Client UI**: real Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`. Overview lists what the app manages (fetched from
  a new server `/meta` route); Setup Guide walks through the app registration,
  Graph application permissions + admin consent, credential mapping and tenant
  wiring; Connections uses the shared `<ConnectionsManager>` configured for the
  app-registration credential (Application (client) ID + client secret) and the
  `entra-tenant` deploy target.
- Server `/meta` and `/settings` routes.

### Changed
- Replaced the template placeholder logo with an original Entra-branded mark
  (blue/cyan). Removed the remaining template placeholder client pages.

## 0.3.0 — 2026-07-26

### Added
- **Conditional Access Policies** configuration type — the flagship. Manage CA
  policies as code with the full pipeline handler set: user/group and cloud-app
  targeting, grant controls (MFA, compliant device, block, …) with an OR/AND
  operator. Groups are referenced by display name and resolved to ids at deploy
  time, composing with the Security Groups type. New policies default to
  **report-only** (never enforced on creation); validate enforces block
  exclusivity and warns when an enforced policy has no break-glass exclusion.

## 0.2.0 — 2026-07-26

### Added
- **Security Groups** configuration type — manage Entra assigned security groups
  (display name, description, mail nickname) as code, with the full pipeline
  handler set. Mail-enabled, Microsoft 365 (Unified) and dynamic-membership
  groups are protected: deploy refuses to modify a live name-match that is not a
  plain assigned security group, and reconcile only deletes groups this app
  created. Mail nicknames are derived from the display name when left blank.

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
