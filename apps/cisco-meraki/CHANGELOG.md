# Changelog

All notable changes to the Cisco Meraki app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-03

### Added

Nine more configuration types, exhausting the meaningfully declarative,
network-scoped MX appliance / switch write surface — across three shapes:

- **Ordered whole-list singletons** (same GET/PUT `{ rules: [...] }` shape as
  L3/L7 Firewall Rules) — `one-to-one-nat`, `one-to-many-nat`,
  `port-forwarding-rules`, `switch-access-control-lists`. Factored onto a new
  shared engine, **`lib/merakiOrderedList.ts`**, so deploy/rollback/
  driftDetect/healthCheck are thin per-type wrappers; each type keeps its own
  `validate.ts` and rule-shape types since the item schemas genuinely differ
  (NAT rules have nested `allowedInbound`/`portRules`; port forwarding has a
  richer uplink enum than the NAT endpoints' "internetN"; switch ACLs add
  `ipVersion`/`vlan`). **Switch ACLs flag a real behavioral asymmetry**: unlike
  L3 firewall rules, Meraki documents that an *empty* `rules` array **clears**
  all switch ACLs rather than falling back to an implicit default rule —
  `validate` warns (`EMPTY_RULES_CLEARS_ACL`) rather than treating it the same
  as L3's "only the default rule applies."
- **Whole-object settings singletons** (one JSON object per network, GET/PUT,
  no array) — `appliance-security-intrusion` (IPS: mode, IDS ruleset,
  protected-networks scope), `appliance-security-malware` (AMP: mode plus
  allowed-URL/allowed-file exceptions), `appliance-content-filtering`
  (allowed/blocked URL patterns, blocked categories, category list size) and
  `site-to-site-vpn` (Auto VPN mode, hubs, subnets, NAT). Factored onto a new
  shared engine, **`lib/merakiSingleton.ts`**: the exact documented request
  object is authored as one JSON blob (`settings`) per network — so new
  vendor fields pass through without an app release — while
  `transport.validate()` still checks every documented enum (intrusion's
  `mode`/`idsRulesets`, malware's `mode`, content filtering's
  `urlCategoryListSize`, VPN's `mode`) and the one conditional requirement
  Meraki's own schema states: intrusion's `protectedNetworks.includedCidr` /
  `excludedCidr` are **required** when `useDefault` is `false`. Drift
  comparison uses a recursive `projectDeclared()` so only the keys actually
  declared are compared against the live object, at any nesting depth — not
  just top-level keys.
- **Firewalled Services (`firewalled-services`)** — the one endpoint that fits
  neither shape: ICMP, web and SNMP are a **fixed, uncreatable set**, so this
  models the singleton engine's `settings` object as `{ services: [...] }` and
  `put()` loops a `PUT .../firewalledServices/{service}` per declared entry.
  Every declared entry is an update, never a create/delete. `validate` checks
  the documented `access` enum (blocked/restricted/unrestricted) and that
  every entry names a service.
- **Coverage.** A new README section auditing the full Meraki Dashboard API v1
  surface: every managed declarative endpoint, and — as important — what is
  **intentionally excluded** and why (device/port-scale resources like switch
  ports and per-radio wireless settings; organization-wide resources outside
  this app's network-canvas ownership boundary; imperative Live Tools/action
  endpoints; read-only monitoring/audit endpoints; licensing). Drop-don't-fake:
  nothing here is stubbed or faked as "supported."
- `lib/merakiApi.ts` extended with all nine endpoints' GET/PUT/POST/DELETE
  operations (plus `listContentFilteringCategories` for reference) and a
  shared `checkMerakiReachable()` health check, reusing the existing
  Bearer-auth / 429-`Retry-After`-backoff transport unchanged since v0.1.0.
- Every configuration type across all thirteen now declares a sidebar
  `group`: "Appliance · Firewall" (L3/L7, NAT ×2, port forwarding, firewalled
  services), "Appliance · Security" (intrusion, malware, content filtering),
  "Appliance · VPN" (site-to-site VPN), "Network" (group policies, VLANs) and
  "Switch" (switch ACLs).

## 0.2.0 — 2026-08-02

### Added
- **L7 Firewall Rules (`l7-firewall-rules`).** The MX L7 (application-layer)
  firewall ruleset for a network — an ordered list of "deny" rules (by
  application, application category, host, port, IP range, or allowed/
  blocked country) evaluated top-to-bottom on top of the L3 posture — applied
  as a whole-list replace via `PUT
  /networks/{networkId}/appliance/firewall/l7FirewallRules`. Same ordered-
  singleton-per-network shape as L3, minus L3's write-only
  `syslog_default_rule` (L7 has no companion scalar). The `value` object
  shape for `application`/`applicationCategory` rules is **flagged as
  unverified** beyond "it's an object" — `validate` warns rather than
  silently trusting it (see README "Known limitations").
- **Group Policies (`group-policies`).** A PER-OBJECT resource — unlike the
  firewall-rules types, Meraki assigns each policy a server-side
  `groupPolicyId`, so this reconciles by **name** within a network:
  `GET /networks/{networkId}/groupPolicies` (list) → match by name →
  `PUT .../groupPolicies/{id}` (update) or `POST .../groupPolicies` (create).
  The schema (scheduling, bandwidth, firewall/traffic-shaping, content
  filtering, splash auth, VLAN tagging, Bonjour forwarding) is large and
  deeply nested, so — following Cribl's Sources/Destinations precedent —
  `name` is a typed canvas field and everything else is authored as one JSON
  blob (`policy`), sent as `{ name, ...policy }`. Only the well-known
  top-level `*.settings` enums are validated; the rest passes through as
  declared. `rollback` restores an updated policy's prior body or deletes a
  created one — deletion does **not** pass Meraki's optional `force` query
  parameter, so removing a policy still assigned to clients surfaces as a
  clear rollback failure rather than being silently forced through.
- **Appliance VLANs (`appliance-vlans`).** A PER-OBJECT resource whose id is
  **caller-chosen** (1-4094), not server-assigned — reconciled by VLAN id
  within a network (list → match by id → update or create), the same
  upsert-by-id shape Cribl's Sources/Destinations use. Well-known scalar
  fields (name, subnet, applianceIp, groupPolicyId, vpnNatSubnet, the DHCP
  settings — `dhcpHandling`/`dhcpLeaseTime` validated against their
  documented enums) are typed canvas fields; the long tail
  (fixedIpAssignments, reservedIpRanges, dhcpOptions, mandatoryDhcp, ipv6,
  sgt, vrf, uplinks, templateVlanType, cidr, mask) is one JSON blob
  (`advanced`). **Flagged precondition:** VLANs must already be *enabled* on
  a network (an MX ships in single-LAN mode) — `deploy` checks this
  (`GET .../appliance/vlans/settings`) and fails fast with an actionable
  message rather than surfacing Meraki's own error, but deliberately does
  **not** flip the switch automatically (a disruptive, operator-deliberate
  change to the network's addressing mode).
- **`lib/merakiCommon.ts`** — network-id validation, boolean-ish canvas-value
  parsing, and order/key-sensitive JSON comparison (`canonicalJson`,
  `pickKeys`), factored out of `l3-firewall-rules/_shared.ts` (which now
  re-exports them) so all four config types share one implementation.
- `lib/merakiApi.ts` extended with L7 firewall rules, group policies and
  appliance VLAN operations, reusing the existing Bearer-auth /
  429-`Retry-After`-backoff transport from v0.1.0.
- Every configuration type now declares a sidebar `group` — "Appliance ·
  Firewall" for the two firewall-rules types, "Network" for group policies
  and appliance VLANs.

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
