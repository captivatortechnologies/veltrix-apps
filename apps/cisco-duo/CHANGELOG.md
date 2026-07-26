# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.2.0 — 2026-07-26

### Added
- **Integrations** configuration type — manage Duo integrations (name + type) as
  code, with the full pipeline handler set. Integrations are id-addressed by
  `integration_key` with no lookup-by-name, so the app matches by name and stores
  the key for rename-safety; the type is immutable (a same-name integration of a
  different type is not modified); reconcile only deletes integrations this app
  created. (Duo generates the integration secret; retrieve it from the Admin
  Panel.)

## 0.1.0 — 2026-07-26

### Added
- Initial release. Cisco Duo Admin API client (`lib/duo.ts`) with HMAC-SHA1
  request signing over form-encoded params, the `{stat, response}` envelope,
  `metadata.next_offset` pagination and RFC 2822 date handling.
- **Groups** configuration type — manage Duo groups (name + description) as code,
  with the full pipeline handler set: validate, deploy, rollback, drift detection,
  health check and status. Duo groups are id-addressed with no lookup-by-name, so
  the app matches by name and stores the `group_id` after deploy for
  rename-safety; reconcile only deletes groups this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the integration key + secret key credential and the `cisco-duo`
  deploy target.
- Connection test (`handlers/testConnection.ts`) signing a request to Duo's
  `/admin/v1/check` endpoint.
