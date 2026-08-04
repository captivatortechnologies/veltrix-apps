# Cisco Meraki (Veltrix app)

Manage [Cisco Meraki](https://meraki.cisco.com) Dashboard network security
configuration as code through the **Meraki Dashboard API v1**, driven by the
Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detect → rollback).

## What it manages

| Configuration type | Meraki object | Identity | API operations |
| --- | --- | --- | --- |
| **L3 Firewall Rules** (`l3-firewall-rules`) | MX L3 (outbound) firewall ruleset, per network | `network_id` (singleton) | `GET` / `PUT /networks/{networkId}/appliance/firewall/l3FirewallRules` |
| **L7 Firewall Rules** (`l7-firewall-rules`) | MX L7 (application-layer) firewall ruleset, per network | `network_id` (singleton) | `GET` / `PUT /networks/{networkId}/appliance/firewall/l7FirewallRules` |
| **Group Policies** (`group-policies`) | Bandwidth / firewall-traffic-shaping / content-filtering / splash-auth / VLAN-tagging / Bonjour policy | `name`, per network | `GET/POST /networks/{networkId}/groupPolicies`, `PUT/DELETE .../groupPolicies/{groupPolicyId}` |
| **Appliance VLANs** (`appliance-vlans`) | MX appliance VLAN — addressing + DHCP | `id` (caller-chosen, 1-4094), per network | `GET/POST /networks/{networkId}/appliance/vlans`, `PUT/DELETE .../vlans/{vlanId}` |

### L3 Firewall Rules — an ordered singleton per network

Meraki stores a network's whole MX L3 (outbound) firewall ruleset as **one
ordered list**; there is no API to create or delete an individual rule, only a
**whole-list replace**. This config type therefore models **one canvas item per
Meraki network**, identified by its `network_id` — the same shape used for
Cribl's Routes config type. The ordered `rules` array is authored as JSON;
**order is significant** (rules are evaluated top to bottom) and drift
detection compares the list **order-sensitively**.

Meraki appends an implicit final **"Default rule"** (`allow any/any`) after
every custom rule. It is never part of the managed list — the API excludes it
on read and rejects it if you try to declare it — and it cannot be edited or
removed through this endpoint.

Deploy always reads the network's current ruleset first (captured as
`rollbackData`) before overwriting it, so rollback can restore the exact prior
ordered list.

#### `syslog_default_rule` — a write-only flag

The canvas also exposes **"Log the Default Rule"** (`syslog_default_rule`),
which maps to the API's `syslogDefaultRule` boolean. Meraki accepts this field
on `PUT` but **never returns its current value** on `GET` or `PUT` — the
response is always just `{ "rules": [...] }`. As a direct consequence:

- **Drift detection never compares it** — there is nothing live to diff against.
- **Rollback never restores it** — there is no prior value on record. Rollback
  restores the ordered `rules` list only and omits `syslogDefaultRule` from its
  restore request entirely, rather than guessing a value.
- Every successful **deploy** re-applies whatever value is currently declared
  on the canvas.

### L7 Firewall Rules — the same ordered-singleton shape, layered on top of L3

Same GET/PUT-whole-list shape as L3, with three differences: `policy` is
always `"deny"` (L7 has no allow rule — it only adds blocks on top of the
default-allow L3 posture); `type` selects `application`,
`applicationCategory`, `host`, `port`, `ipRange`, `allowedCountries` or
`blockedCountries` (plus the legacy `whitelistedCountries` /
`blacklistedCountries` synonyms Meraki's own schema still lists); and `value`'s
shape depends on `type` — a string for host/port/ipRange, an array of ISO
3166-1 alpha-2 codes for the country types, and **an object for
application/applicationCategory whose exact shape is not independently
verified in this app** (it references an id from the MX L7 application
categories endpoint) — `validate` accepts any object there but emits an
`UNVERIFIED_VALUE_SHAPE` warning rather than silently trusting it. There is no
L7 equivalent of `syslog_default_rule`.

### Group Policies — reconciled by name, schema authored as JSON

A group policy is Meraki-assigned an id (`groupPolicyId`) on create, so this
type reconciles by **name** within a network (list → match → update or
create), the same shape `wiz-cloud-config-rules` uses in the Wiz app. The
schema itself (scheduling, bandwidth, firewall/traffic-shaping — including
nested L3/L7 rules and traffic-shaping definitions — content filtering, splash
auth, VLAN tagging, Bonjour forwarding) is large and deeply nested, so —
following Cribl's Sources/Destinations `{ id, type, ...conf }` precedent —
only `name` is a typed canvas field; everything else is one JSON blob
(`policy`), sent as `{ name, ...policy }`. `validate` checks the well-known
top-level `*.settings` enums (`bandwidth.settings`,
`firewallAndTrafficShaping.settings`, `vlanTagging.settings`,
`bonjourForwarding.settings`, the three `contentFiltering.*.settings`,
`splashAuthSettings`) but does not deep-validate the rest — Meraki validates
it at deploy time. `rollback` restores an updated policy's prior body, or
deletes a created one; delete does **not** pass Meraki's optional `force`
query parameter (removing a policy still assigned to clients surfaces as a
clear rollback failure instead of being silently forced through).

### Appliance VLANs — reconciled by a caller-chosen id; requires VLANs enabled

Unlike group policies, a VLAN's `id` is **chosen by the caller** (1-4094) and
sent in the create body — Meraki assigns nothing — so this reconciles by `id`
within a network (list → match by id → update or create), the same
upsert-by-id shape Cribl's Sources/Destinations use. The well-known scalar
fields (`name`, `subnet`, `applianceIp`, `groupPolicyId`, `vpnNatSubnet`, and
the DHCP settings — `dhcpHandling` / `dhcpLeaseTime` validated against their
documented enum values) are typed canvas fields; the long tail
(`fixedIpAssignments`, `reservedIpRanges`, `dhcpOptions`, `mandatoryDhcp`,
`ipv6`, `sgt`, `vrf`, `uplinks`, `templateVlanType`, `cidr`, `mask`) is one
JSON blob (`advanced`), merged in with the typed fields always winning on a
key collision.

**Precondition — VLANs must be enabled on the network.** An MX ships in
single-LAN mode; per-VLAN CRUD only works once VLANs are turned on
(`Security & SD-WAN > Addressing & VLANs > "VLANs enabled"`, or
`PUT .../appliance/vlans/settings { vlansEnabled: true }`). `deploy` **checks**
this first (`GET .../appliance/vlans/settings`) and fails fast with an
actionable message when it's off, but **deliberately does not flip the switch
for you** — that's a disruptive, one-way-in-practice change to the network's
addressing mode an operator should make on purpose. `healthCheck` also
reports it per network. Meraki may also refuse to delete a network's last
remaining VLAN while VLANs stay enabled; this is not independently
re-verified beyond the endpoint's own error, so a rollback that needs to
delete a VLAN can fail — surfaced as a clear rollback error.

## Authentication

A **Meraki Dashboard API key**. In the dashboard, enable API access
(**Organization → Settings → Dashboard API access**), then generate a key from
your admin profile page (**Generate new API key** — shown once). Store it as a
Veltrix credential:

- **API token** → the Meraki Dashboard API key

The app sends it as `Authorization: Bearer <key>` (the modern v1 scheme; the
legacy `X-Cisco-Meraki-API-Key` header is not used) to the **fixed** base
`https://api.meraki.com/api/v1` — there is no per-organization API host.

## Component

Register a `meraki-organization` component and attach the credential. Because
the API base is fixed, the component's hostname is only a human label (e.g.
your organization's name) and is never used as a network address.

Every config type's canvas item independently targets one Meraki **network**
by its `network_id` (e.g. `L_646829496481099008` / `N_646829496481099008`) —
find it in the dashboard URL for that network, or via
`GET /organizations/{organizationId}/networks`.

## Rate limiting

The Meraki Dashboard API enforces **10 requests/second per organization**
(burst +10 in the first second, up to 30 in a 2-second window) and **100
requests/second per source IP**. A `429` response includes a `Retry-After`
header (seconds); the client honors it with a bounded retry before failing.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Meraki Dashboard API calls. |

## Known limitations (historical v0.2.0 notes; superseded by Coverage below)

- One-to-one/one-to-many NAT, port forwarding, site-to-site VPN, wireless
  SSIDs, switch ports, etc. are not yet covered — planned as additional
  configuration types in a future release.
- No live pre-check that `network_id` refers to an MX-capable (appliance)
  network at `validate` time — an invalid or non-appliance network surfaces a
  clear error from Meraki at `deploy` time instead.
- **L7 Firewall Rules**: the `value` object shape for `application` /
  `applicationCategory` rules is not independently verified beyond "it's an
  object" — `validate` warns rather than silently trusting it. Confirm the
  exact shape against the MX L7 application categories endpoint before
  relying on it in automation.
- **Group Policies**: only the top-level `*.settings` enums inside the
  `policy` JSON blob are validated; the full nested schema (scheduling days,
  traffic-shaping rule definitions, content-filtering patterns, Bonjour
  rules, ...) is passed through as declared. `rollback`'s delete does not
  pass Meraki's optional `force` query parameter.
- **Appliance VLANs**: `deploy`/`healthCheck` check that VLANs are enabled on
  the network but never enable them automatically. Whether Meraki refuses to
  delete a network's last remaining VLAN (and the exact accepted keyword set
  for `dnsNameservers` beyond the observed `"google_dns"` example) are not
  independently re-verified beyond the endpoints' own documented schemas.
- No drift-attribution ("who changed it + when"). Meraki's
  `getOrganizationConfigurationChanges` audit log could support this (as the
  Wiz app does via its own audit log) — deferred to a follow-up release.

## Development

```
cd apps/cisco-meraki
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs cisco-meraki          # run handler tests
node ../../scripts/validate-app.mjs apps/cisco-meraki  # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against the Cisco Meraki Dashboard API v1 API Index and
the endpoint-specific request schemas (API version 1.72.0 on 2026-08-03).

### Managed declarative network configuration

| Configuration type | Dashboard API operations |
| --- | --- |
| L3 firewall rules | `GET` / `PUT /networks/{networkId}/appliance/firewall/l3FirewallRules` |
| L7 firewall rules | `GET` / `PUT /networks/{networkId}/appliance/firewall/l7FirewallRules` |
| Group policies | list/create/get/update/delete `/networks/{networkId}/groupPolicies` |
| Appliance VLANs | VLAN-enabled precheck plus list/create/update/delete `/networks/{networkId}/appliance/vlans` |
| Intrusion prevention | `GET` / `PUT /networks/{networkId}/appliance/security/intrusion` |
| Malware protection | `GET` / `PUT /networks/{networkId}/appliance/security/malware` |
| Content filtering | `GET` / `PUT /networks/{networkId}/appliance/contentFiltering` (categories are read for reference) |
| One-to-one NAT | `GET` / `PUT /networks/{networkId}/appliance/firewall/oneToOneNatRules` |
| One-to-many NAT | `GET` / `PUT /networks/{networkId}/appliance/firewall/oneToManyNatRules` |
| Port forwarding | `GET` / `PUT /networks/{networkId}/appliance/firewall/portForwardingRules` |
| Firewalled services | list/get/update `/networks/{networkId}/appliance/firewall/firewalledServices` |
| Site-to-site VPN | `GET` / `PUT /networks/{networkId}/appliance/vpn/siteToSiteVpn` |
| Switch ACLs | `GET` / `PUT /networks/{networkId}/switch/accessControlLists` |

Every whole-list endpoint is order-sensitive and captures the complete prior
list for rollback. Singleton settings preserve the exact declared JSON object;
this also permits newly added vendor fields without an app release.

### Intentionally excluded

- Device- and port-scale resources (switch ports, routing interfaces, device
  management interfaces, per-radio settings) and wireless SSIDs/access-control
  families are declarative, but require a separate component/target model and
  can fan out to thousands of devices. They are not represented as a misleading
  network singleton in this app.
- Organization-wide administrators, networks, policy objects/adaptive policy,
  templates, inventory/claiming and licensing are outside this app's
  `meraki-organization` connection plus network-canvas ownership boundary.
- Appliance settings, static routes, DHCP, BGP, cellular, traffic shaping,
  uplinks, warm spare and Secure Router-only endpoints are valid future
  configuration families, but are excluded until their hardware/license mode
  prerequisites and rollback semantics can be modeled safely.
- Live Tools, action endpoints, firmware upgrades, reboots, packet capture,
  ping/wake/sensor actions and policy deploy jobs are imperative operations,
  not durable desired state.
- Events, clients, traffic, topology, health, usage, audit/configuration-change
  logs and other monitor endpoints are read-only. Credential/API-key and SAML
  administration is security-sensitive control-plane bootstrap, not canvas
  configuration.

Primary references: [Meraki API Index](https://developer.cisco.com/meraki/api-v1/api-index/),
[supported resources](https://developer.cisco.com/meraki/api-v1/supported-resources/),
and each endpoint page linked in `lib/merakiApi.ts`.
