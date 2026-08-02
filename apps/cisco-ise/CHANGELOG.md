# Changelog

All notable changes to the Cisco ISE app are documented here.

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
