# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.4.0 — 2026-07-26

### Added
- **Firewall Service Groups** configuration type — manage FortiManager service
  groups (a named set of member service objects) as code; members reference
  existing firewall services (compose with the Firewall Services type).
  `obj/firewall/service/group`.
- **Firewall IP Pools** configuration type — manage FortiManager IPv4 IP pools
  (overload / one-to-one source-NAT ranges) as code, keyed by name with a start
  and end IP. `obj/firewall/ippool`.
- **Recurring Schedules** configuration type — manage FortiManager recurring
  firewall schedules (one or more weekdays with a start/end time-of-day window)
  as code. `obj/firewall/schedule/recurring`.
- **One-time Schedules** configuration type — manage FortiManager one-time
  firewall schedules (a single `hh:mm yyyy/mm/dd` start/end window) as code.
  `obj/firewall/schedule/onetime`.
- **Firewall IPv6 Addresses** configuration type — manage FortiManager IPv6
  address objects (ipprefix / iprange / fqdn) as code, the IPv6 analog of the
  Firewall Addresses type. `obj/firewall/address6`.
- **Wildcard FQDNs** configuration type — manage FortiManager wildcard-FQDN
  address objects (domain patterns with `*` wildcards, e.g. `*.example.com`) as
  code. `obj/firewall/wildcard-fqdn/custom`.
- All six types are name-keyed and upserted with `set`; reconcile only deletes
  objects this app created; deploys/rollbacks run inside the ADOM workspace
  transaction (reusing `firewall-addresses` `finishWorkspace`) when enabled.

## 0.3.0 — 2026-07-26

### Added
- **Firewall Address Groups** configuration type — manage FortiManager address
  groups (a named set of member address objects) as code, with the full pipeline
  handler set. Groups are matched by name and upserted with `set`; members
  reference existing firewall address objects (compose with the Firewall
  Addresses type); reconcile only deletes groups this app created; deploys run
  inside the ADOM workspace transaction when enabled.

## 0.2.0 — 2026-07-26

### Added
- **Firewall Services** configuration type — manage FortiManager custom firewall
  service objects (TCP/UDP/SCTP port ranges, ICMP/ICMP6 type+code, or IP protocol
  number) as code, with the full pipeline handler set. Services are matched by
  name and upserted with `set`; port ranges are sent as the `[…]` string arrays
  FortiManager expects; reconcile only deletes services this app created; deploys
  run inside the ADOM workspace transaction when enabled.

## 0.1.0 — 2026-07-26

### Added
- Initial release. FortiManager JSON-RPC API client (`lib/fortimanager.ts`) with
  session login/logout, single-endpoint RPC (get / add / set / delete), automatic
  re-login on session expiry, and optional ADOM workspace lock / commit / unlock.
- **Firewall Addresses** configuration type — manage FortiManager firewall
  address objects (ipmask / iprange / fqdn / geography) as code, with the full
  pipeline handler set: validate, deploy, rollback, drift detection, health check
  and status. Addresses are matched by their `name` (the FortiManager mkey) and
  upserted with `set`; reconcile only deletes addresses this app created. When the
  ADOM is in workspace mode, deploys/rollbacks run inside a lock / commit / unlock
  transaction.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the admin username + password credential and the `fortimanager`
  deploy target.
- Connection test (`handlers/testConnection.ts`) verifying the JSON-RPC login +
  ADOM access.
