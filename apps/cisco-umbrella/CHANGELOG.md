# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.3.0 — 2026-08-04

### Added
- Configuration types are now **grouped by Umbrella API family** in the
  sidebar (`group: "Deployments"` / `group: "Policies"`, mirroring Cisco's own
  Umbrella API section naming), covering all 7 config types.
- **Internal Network Subnets** configuration type (`internal-network-subnets`)
  — manage Umbrella's *Internal Networks* resource (RFC1918/non-RFC1918
  subnets tied to exactly one Site, Network or Tunnel) as code via
  `/deployments/v2/internalnetworks` (full CRUD: create/get/list/update/delete
  — confirmed via Cisco's own Refit-based client,
  `github.com/panoramicdata/Cisco.Api`). Fields: `name` (identity),
  `ipAddress`, `prefixLength` (9–32), and an `associationType`
  (site/network/tunnel) + `associationName` pair — the declared
  Site/Network/Tunnel NAME is resolved to Umbrella's opaque id at deploy time.
  Full pipeline handler set. **NOTE:** this is a *different* Umbrella resource
  from this app's pre-existing `internal-networks` config type, which targets
  `/deployments/v2/networks` (egress IPs) — the naming collision is inherited
  from the app's original registration and documented in both configs.
- **Network Tunnels** configuration type (`network-tunnels`) — manage Umbrella
  IPsec network tunnels as code via `/deployments/v2/tunnels` (create, list,
  delete — **no update/PATCH endpoint was found in any reference**, so an
  existing tunnel is left untouched by deploy; remove and re-declare the item
  to recreate it). Fields: `name` (identity), `deviceType` (free text — no
  published enum), `pskSecret` (write-only password field, PSK
  authentication), `idPrefix`, and an optional `siteName` resolved to
  Umbrella's `siteOriginId`. Full pipeline handler set (rollback only removes
  tunnels this app created; drift compares `deviceType` only — the secret is
  never returned by the API).
- **Internal Network Policy Assignments** configuration type
  (`internal-network-policy-assignments`) — the one CONFIRMED write capability
  on an otherwise **read-only** Umbrella policy: assigning/unassigning an
  Internal Network Subnet identity to/from an existing DNS or Web policy via
  `PUT`/`DELETE /deployments/v2/policies/{policyId}/identities/{originId}`
  (no body). Confirmed via two independent sources — Cisco's own Refit client
  (`IUmbrella.AddIdentityToPolicyAsync` / `DeleteIdentityFromPolicyAsync`) and
  Microsoft's official Azure Sentinel "CiscoUmbrella-AssignPolicyToIdentity"
  playbook, which calls this exact path against `api.umbrella.com`. Fields:
  `identityName` (an Internal Network Subnet name), `policyType` (dns/web),
  `policyName` — both names resolved to Umbrella's ids at deploy time.
  Reconcile/rollback only ever touch memberships this app added; an
  assignment that predates this app's deploy is left in place. Scoped to
  Internal Network Subnet identities only — the one identity kind with a
  CONFIRMED read-back endpoint too
  (`GET /deployments/v2/internalnetworks/{originId}/policies`), which lets
  drift detection verify an assignment instead of only ever asserting it
  blindly.
- New app permissions: `internal-network-subnets`, `network-tunnels`,
  `internal-network-policy-assignments` (read/write/delete).

### Investigated and intentionally excluded (see README "Coverage")
- **DNS/Web Policies** (the policy object/ruleset itself): confirmed
  **read-only** — `GET /deployments/v2/policies?type=dns|web` only. No
  create/update/delete was found in Cisco's official external Postman
  collection, the community `josgabfer/UmbrellaAPI` project, or Cisco's Refit
  client. Policy composition (content filtering, security settings, block
  pages, rule ordering) remains dashboard-only.
- **Virtual Appliances**, **Roaming Computers**, **Network Devices**:
  confirmed read-only (list/get only) across every reference checked; per
  established per-app-authoring convention, per-device/per-appliance
  inventory is not modeled as canvas configuration.
- **Device Tagging** (`/deployments/v2/tags`): can create tags and
  assign/remove them on devices, but no delete-tag endpoint was found anywhere
  — the create/track/delete reconcile lifecycle this app requires cannot be
  safely implemented, and tag-to-device assignment is device inventory, not
  policy configuration.
- **Admin** (Roles/Users/API Keys): security-sensitive control-plane
  bootstrap, excluded on the same precedent as `cisco-meraki`'s organization
  administrator exclusion.
- **Selective Decryption Lists**: investigated and NOT found as a documented
  endpoint anywhere in classic Umbrella's public API (`api.umbrella.com`) —
  only exists under the separate "Cisco Secure Access" product
  (`api.sse.cisco.com`, a different base URL/product), which is out of this
  app's scope.
- Reports, Investigate, Activity and API-usage APIs: entirely read-only
  telemetry.

> **Research basis:** this release was built by cross-referencing Cisco's
> official external Postman collection (`CiscoDevNet/cloud-security`), the
> community `josgabfer/UmbrellaAPI` project (working scripts hitting
> `api.umbrella.com` directly), Cisco's own Refit-based `.NET` client
> (`panoramicdata/Cisco.Api`, with XML-documented request/response models),
> and Microsoft's official Azure Sentinel Cisco Umbrella playbooks — not
> assumed from memory. **FLAGGED as unverified against a live tenant:** the
> exact `deviceType` enum for tunnels (only `"other"` is confirmed working),
> the tunnel response shape (one sample nests client config under a `client`
> key), and whether an Internal Network Subnet's `prefixLength` bound (9–32)
> is enforced server-side exactly as documented.

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
