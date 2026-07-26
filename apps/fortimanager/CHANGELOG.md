# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

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
