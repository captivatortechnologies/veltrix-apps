# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Google Security Operations (Chronicle) REST API client
  (`lib/googlesecops.ts`) with service-account auth — a JWT signed RS256 with the
  key's private key (via Node's built-in crypto, no extra dependency) is exchanged
  for a Bearer token that is cached and refreshed; regionalized API host + the
  projects/locations/instances resource parent.
- **Reference Lists** configuration type — manage SecOps reference lists (named
  string / regex / CIDR entry sets) as code, with the full pipeline handler set:
  validate, deploy, rollback, drift detection, health check and status. Lists are
  keyed by their immutable reference list id; entries are reconciled to exactly
  the declared set (a full-replace PATCH); the syntax type is fixed at creation.
  Reference lists cannot be deleted, so reconcile empties the ones this app
  created but no longer declares, and rollback restores prior entries (or empties
  a created list).
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the service-account-key credential and the `google-secops`
  deploy target.
- Connection test (`handlers/testConnection.ts`) minting a token and listing
  reference lists.
