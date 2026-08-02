# Changelog

All notable changes to the Cisco Meraki app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-02

### Added
- **Initial release.** Manage Cisco Meraki Dashboard network security
  configuration as code through the Meraki Dashboard API v1.
- **L3 Firewall Rules (`l3-firewall-rules`).** The MX L3 (outbound) firewall
  ruleset for a network — an ordered list of allow/deny rules evaluated
  top-to-bottom — applied as a whole-list replace via `PUT
  /networks/{networkId}/appliance/firewall/l3FirewallRules`. Modeled as an
  ordered singleton per network (one canvas item = one network's ruleset,
  identified by `network_id`), the same shape as Cribl's Routes config type:
  - `validate` checks the network id shape, rejects malformed/unsupported
    `policy` and `protocol` values, and warns (without blocking) on a
    duplicate network id or an empty ruleset.
  - `deploy` reads the network's current ruleset first (captured for
    rollback) and then overwrites it with the declared ordered list.
  - `rollback` restores the exact prior ordered ruleset. It deliberately never
    restores the `syslog_default_rule` flag — Meraki does not return its
    current value on `GET` or `PUT`, so there is no prior value to restore.
  - `driftDetect` compares the declared ordered ruleset against the live one,
    order-sensitively; `syslog_default_rule` is never diffed for the same
    reason it is never restored.
  - `healthCheck` verifies Dashboard API reachability (`GET /organizations`)
    and that every declared network's ruleset is still readable.
- **Meraki Dashboard API client (`lib/merakiApi.ts`).** Fixed base
  (`https://api.meraki.com/api/v1`), `Authorization: Bearer <key>` auth, and
  bounded `429`/`Retry-After` backoff (Meraki enforces 10 req/s per
  organization, burst +10 in the first second, and 100 req/s per source IP).
- **Connectivity test** (`handlers/testConnection`) — verifies the Dashboard
  API key via `GET /organizations`.
