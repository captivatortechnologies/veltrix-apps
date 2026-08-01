# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-08-01

### Added
- Initial release. Cisco Umbrella API client (`lib/umbrellaApi.ts`) implementing
  the **OAuth2 client-credentials** flow: `POST /auth/v2/token` with HTTP Basic
  (API key + secret) and a form-encoded `grant_type=client_credentials` body
  returns a ~1-hour bearer token (cached per key/secret, single 401 re-auth
  retry); requests carry `Authorization: Bearer <token>` against the fixed base
  URL `https://api.umbrella.com`. Includes the `{ status, meta, data }` envelope
  helpers and page/limit collection paging.
- **Destination Lists** configuration type — manage Umbrella destination lists
  (allow/block lists of domains, URLs and IPs) as code via
  `/policies/v2/destinationlists`, with the full pipeline handler set: validate,
  deploy, rollback, drift detection, health check and status. Lists are matched
  by name and their id is stored after deploy for rename-safety; a list's
  destinations are synced to exactly what is declared (add/remove batched at
  Umbrella's 500-per-request cap); `access` (allow/block) and global scope are
  set at create time and reported as immutable notes on change; reconcile only
  deletes lists this app created. Validation warns when a destination's type is
  unsupported for the access mode (URLs are block-only; IPv4 is allow-only).
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the API key + secret credential and the `cisco-umbrella` deploy
  target.
- Connection test (`handlers/testConnection.ts`) minting an OAuth2 token and
  reading the destination lists collection.

> **Verification note:** API paths, the `{ status, meta, data }` envelope and the
> destination object shapes follow the Cisco Umbrella API (Cloud Security)
> documentation. Verify against a live Umbrella tenant before production use.
