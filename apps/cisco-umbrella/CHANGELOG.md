# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.2.0 — 2026-08-01

### Added
- Shared **Umbrella Deployments API** engine (`lib/deployments.ts`) — bare-array
  paging + bare-object parsing (the `/deployments/v2/*` surface is *not*
  enveloped, unlike Policies v2) and a generic upsert-by-identity / rollback /
  drift engine reused by the three new config types. Each resource is matched by
  its identity field and its opaque id is stored after deploy for rename-safety;
  reconcile only deletes resources this app created.
- **Networks** configuration type (`internal-networks`) — manage Umbrella
  registered networks (egress IP ranges) as code via `/deployments/v2/networks`
  (create/get/update/delete). Fields: `name` (identity), `ipAddress`,
  `prefixLength`, `isDynamic`. Dynamic networks may omit the IP; static networks
  require a valid IPv4 and a 0–32 prefix. Full pipeline handler set (validate,
  deploy, rollback, drift, health, status).
  > **Naming note:** registered under the id `internal-networks` per the app
  > spec, but it targets the Umbrella **Networks** API — *not*
  > `/deployments/v2/internalnetworks` (RFC-1918 subnets tied to a
  > Site/Network/Tunnel). The endpoint + fields (`isDynamic`) are the registered
  > Networks resource.
- **Internal Domains** configuration type — manage domains whose DNS bypasses the
  Umbrella resolvers to the local resolver via `/deployments/v2/internaldomains`.
  Fields: `domain` (identity), `description`, `includeAllVAs`,
  `includeAllMobileDevices`. Full pipeline handler set.
- **Sites** configuration type — manage Umbrella sites (Virtual Appliance
  location groupings) via `/deployments/v2/sites`. Field: `name` (identity).
  Reconcile/rollback never delete the default site. Full pipeline handler set.
- New app permissions: `internal-networks`, `internal-domains`, `sites`
  (read/write/delete).

> **Verification note:** the Deployments v2 endpoints, their identifier fields
> (`originId` for networks, `id` for internal domains, `siteId` for sites) and the
> request/response field shapes follow the Cisco Umbrella API (Cloud Security)
> Deployments documentation. **FLAGGED as unverified against a live tenant:** the
> bare-vs-enveloped response shape (handled defensively), the exact casing of
> `includeAllVAs`/`includeAllMobileDevices` (the legacy Management API used
> lowercase), and whether the Networks API requires a Cisco-verified IP range
> before enforcement. Verify against a live Umbrella tenant before production use.

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
