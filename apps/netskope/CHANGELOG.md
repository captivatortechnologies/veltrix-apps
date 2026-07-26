# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.2.0 — 2026-07-26

### Added
- **Device Classification Tags** configuration type — manage Netskope device
  classification tags (name + description) as code, with the full pipeline
  handler set. Tags are id-addressed with no lookup-by-name, so the app matches
  by name and stores the id for rename-safety; updates use PUT with no
  deploy/apply step; reconcile only deletes tags this app created.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Netskope REST API v2 client (`lib/netskope.ts`) with
  `Netskope-Api-Token` header auth, limit/offset pagination and 429 backoff.
- **URL Lists** configuration type — manage Netskope URL lists (exact URLs/IPs or
  regex patterns) as code, with the full pipeline handler set: validate, deploy,
  rollback, drift detection, health check and status. Lists are id-addressed with
  no lookup-by-name, so the app matches by name and stores the id after deploy for
  rename-safety; a PUT replaces the whole list; reconcile only deletes lists this
  app created. Changes are staged and then applied with a single `deploy` call
  (which applies all pending url-list changes on the tenant).
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the REST API v2 token credential and the `netskope` deploy
  target.
- Connection test (`handlers/testConnection.ts`) verifying the token against
  `GET /api/v2/policy/urllist`.
