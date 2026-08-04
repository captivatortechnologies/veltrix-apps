# Changelog

All notable changes to the Cisco ISE app are documented here.

## 0.3.0 — 2026-08-04

Exhaustion pass — enumerated Cisco ISE's ENTIRE declarative config-as-code
surface across both ERS (`/ers/config/...`) and the newer OpenAPI domain
(`/api/v1/...`) and added every remaining meaningful, safely-flat config type.
Every config type (including 0.1.0's Endpoint Identity Groups) now declares a
sidebar `group`. The README gained a **Coverage** section: every ISE config
surface is either managed or excluded with a stated reason.

- **Downloadable ACLs** config type — create / edit / delete named ACL content
  over `/ers/config/downloadableacl` (wrapper `Downloadableacl`, confirmed from
  the official Ansible collection's own SDK class name). Group: "Policy
  Elements".
- **Allowed Protocols** config type — create / edit / delete Allowed Protocols
  services' TOP-LEVEL authentication-method flags over
  `/ers/config/allowedprotocols` (wrapper `Allowedprotocols`, confirmed
  writable/create-capable from the official Ansible module). Group: "Policy
  Elements". The nested `eapFast`/`eapTls`/`eapTtls`/`peap`/`teap` sub-objects
  (a dozen+ fields each) are out of scope — an update never touches them.
- **Security Group Tags** (SGT) config type — create / edit / delete TrustSec
  SGTs over `/ers/config/sgt` (wrapper `Sgt`, cross-validated against both
  `pyise-ers` and the official Ansible `sgt.py` module). Group: "TrustSec".
  `value: -1` (auto-assign) is preserved as the tag's existing value on an
  UPDATE rather than resent literally. Built-in read-only tags are never
  targeted.
- **Security Group ACLs** (SGACL) config type — create / edit / delete
  TrustSec SGACLs over `/ers/config/sgacl` (wrapper `Sgacl`, verified against
  `pyise-ers`). Group: "TrustSec". ACL content is newline-joined into ERS's
  single `aclcontent` string.
- **Internal Users** config type — create / edit / delete local ISE users over
  `/ers/config/internaluser` (wrapper `InternalUser`, verified against
  `pyise-ers`'s `add_user`). Group: "Identity Management". Identity-group
  names are resolved to ERS's comma-separated id-string format via a live
  lookup. ⚠ `password` and the separate TACACS+ `enablePassword` are
  write-only — never read back, diffed, logged, or captured for rollback.
- **User Identity Groups** config type — create / edit / delete (user)
  identity groups over `/ers/config/identitygroup` (verified fields/create
  support against the official Ansible `identitygroup.py` module; the
  `IdentityGroup` wrapper key itself is UNVERIFIED — flagged). Group:
  "Identity Management". A genuine parent/child tree — `parent` is authored as
  another group's NAME and resolved to an id via a live self-lookup.
- **Endpoints** config type — create / edit / delete individual endpoint MAC
  records over `/ers/config/endpoint` (the irregular `ERSEndPoint` wrapper key,
  confirmed identically by `pyise-ers` and an independent Cisco curl example).
  Group: "Identity Management". Identity is the MAC address, not `name` — ERS
  filters by `mac.EQ.`, which required a new `identityFilterField` option on
  `lib/iseApi.ts`'s generic client. An optional group name resolves against
  the SAME `EndPointGroup` resource endpoint-identity-groups manages. Profiler
  assignment, portal-user linkage and custom attributes are out of scope.
- **`lib/iseApi.ts`** — added `identityFilterField` to `buildErsResourceClient`
  (for MAC-keyed Endpoint), plus the `InternalUser`, `IdentityGroup`,
  `IseEndpoint`, `DownloadableAcl`, `Sgt`, `Sgacl` and `AllowedProtocols` field
  types.
- **Coverage.** Evaluated and excluded, with reasons documented in the
  README: OpenAPI network-access policy sets / authorization rules / condition
  trees (ordered, hierarchical, position-sensitive — doesn't fit this app's
  flat item-list model); certificates & CSR lifecycle; portals & guest/sponsor
  workflows; per-node/deployment operations (backup/restore, patching, AD
  join/leave, pxGrid); the TrustSec egress matrix; endpoint profiling; and
  session/operational/reporting APIs.

> API verification: `internaluser`, `endpoint` (and its irregular `ERSEndPoint`
> wrapper), `sgt` and `sgacl` field shapes were verified against the community
> `pyise-ers` ERS client (github.com/falkowich/pyise-ers, pyiseers/pyiseers.py),
> actively exercised against real ISE deployments. `downloadableacl`,
> `allowedprotocols`, `identitygroup` and (cross-validated) `sgt` field shapes
> and wrapper keys were verified against the official Cisco ISE Ansible
> collection (github.com/CiscoISE/ansible-ise, plugins/modules/*.py), generated
> from Cisco's own ERS/OpenAPI definitions. All share the same
> `SearchResult` / single-resource-envelope / `Location`-header /
> `ERSResponse.messages` conventions already verified in 0.1.0/0.2.0.
> **Verify against a live ISE node** before treating an edge case — or the one
> unverified wrapper key (`IdentityGroup`) — as final.

## 0.2.0 — 2026-08-02

Three new config types (wave 2) — all name-keyed upsert, all built on a new
generic `lib/iseApi.ts` ERS resource client (`buildErsResourceClient`) shared
across every config type, including a refactor of v0.1.0's Endpoint Identity
Groups onto the same generic client (no behavior change). Every config type
now declares a sidebar `group`.

- **Network Device Groups** config type — create / edit / delete ISE Network
  Device Group (NDG) hierarchies over `/ers/config/networkdevicegroup`. The
  `name` is the full `#`-path from the NDG root (e.g. `Location#All
  Locations#SanJose`); the root-category field `othername` is always derived
  from `name`, never authored separately. Group: "Network Devices".
  **Correction**: verified against the community `pyise-ers` ERS client
  (exercised against real ISE) that the real field is `othername`, not
  `ndgtype` as originally scoped.
- **Network Devices** config type — create / edit / delete network devices
  (NAS/AAA clients) over `/ers/config/networkdevice`: name, IPv4 address(es)
  with mask, NDG membership (defaulted to ISE's own `Location`/`Device Type`
  root requirement), and an optional RADIUS shared secret. Group: "Network
  Devices". ⚠ The shared secret is write-only — never read back, diffed,
  logged, or captured for rollback; a device whose secret was rotated cannot
  have the prior secret restored by rollback (only its non-secret fields are).
  IPv6, TACACS+ and SNMP settings are out of scope.
- **Authorization Profiles** config type — create / edit / delete standard
  ("SWITCH") authorization profiles over `/ers/config/authorizationprofile`:
  access type, VLAN (`nameID` + RFC 2868 tunnel tag `tagID`), DACL, Filter-Id
  ACL, Airespace/WLC ACL, and JSON-authored advanced RADIUS attributes. Group:
  "Policy Elements". TrustSec/TACACS+ profile types, IPv6 ACL variants,
  `macSecPolicy`, `webRedirection`, `reauth` and several vendor-specific
  fields are out of scope (flagged in the README, not faked).
- **`lib/iseApi.ts`** — added `buildErsResourceClient<T>`, the one generic
  ERS CRUD transport (list / findByName / getById / create / update / remove /
  probe) every config type's resource-specific client now specializes, plus
  the `NetworkDeviceGroup`, `NetworkDevice` and `AuthorizationProfile` field
  types and `ndgRootFromName`.

> API verification: `networkdevicegroup` and `networkdevice` field shapes were
> verified against the community `pyise-ers` ERS client
> (github.com/falkowich/pyise-ers, pyiseers/pyiseers.py — `add_device_group` /
> `update_device_group` / `get_device` / `add_device`), which is actively
> exercised against real ISE deployments. `authorizationprofile`'s field shape
> was verified against the official Cisco ISE Ansible collection
> (github.com/CiscoISE/ansible-ise, plugins/modules/authorization_profile.py),
> generated from Cisco's own ERS/OpenAPI definitions. All three share the same
> `SearchResult` / single-resource-envelope / `Location`-header /
> `ERSResponse.messages` conventions already verified for endpoint groups in
> 0.1.0. **Verify against a live ISE node** before treating an edge case as
> final.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Endpoint Identity Groups** config type — create / edit / delete Cisco ISE
  endpoint identity groups (name, description) over the ISE External RESTful
  Services (ERS) API (`/ers/config/endpointgroup`), with validate / deploy
  (upsert by group name) / rollback (restore prior description or delete
  created) / health-check / drift-detect / status. Only non-system-defined
  groups are ever created or modified — ISE's built-in groups are untouched.
- **Connectivity test** against the ERS API (`GET /ers/config/endpointgroup
  ?size=1`, HTTP Basic, self-signed TLS tolerated) using an ISE administrator
  in the ERS-Admin or ERS-Operator group.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (enable
  ERS → administrator account → credential → connection), and Connections
  (wraps the SDK `ConnectionsManager` for an ISE PAN/admin node; saving a
  connection registers `cisco-ise` as a deploy target).

> ERS must be explicitly enabled per PAN/admin node (Administration > System >
> Settings > API Settings > ERS Settings) — the port (9060, fixed) is closed
> until then, so a request against it times out rather than erroring. The ERS
> envelope conventions (`SearchResult` list wrapper, `EndPointGroup` single-
> resource wrapper, `Location`-header id on create, `ERSResponse.messages`
> error shape) are shared across every ERS resource and were verified against
> the DevNet EndPointGroup reference and Cisco's own ERS examples; **verify
> against a live ISE node** before treating an edge case as final. TLS
> verification is off by default (self-signed) and configurable via the
> `verify_tls` setting. Parent/nested endpoint groups are not exposed by the
> current ERS API and are intentionally out of scope.
