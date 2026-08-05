# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.6.0 — 2026-08-05

### Added
- **Firewall IPv6 Address Groups** configuration type — manage FortiManager
  IPv6 address groups (a named set of member `address6` / `addrgrp6` objects)
  as code, the IPv6 analog of the Firewall Address Groups type. Members
  reference existing firewall IPv6 address objects (compose with the Firewall
  IPv6 Addresses configuration type). Name-keyed and upserted with `set`;
  reconcile only deletes groups this app created; deploys/rollbacks run inside
  the ADOM workspace transaction (reusing `firewall-addresses`
  `finishWorkspace`) when enabled. `obj/firewall/addrgrp6`.

### Documentation
- Added a **Coverage** section to README.md auditing every managed
  configuration type against the FortiManager JSON-RPC API, plus a sourced,
  one-line-reasoned list of intentionally-excluded surfaces (firewall policy
  packages / policies, central SNAT, VPN tunnel templates, device /
  provisioning / SD-WAN templates, ADOM management, FortiManager's own admin
  accounts, dynamic objects and metadata variables) — none of which fit this
  app's ADOM shared-object-database, name-keyed, upsert-with-`set` model.
  Refreshed the stale "What it manages" table (previously listing only
  Firewall Addresses despite 31 already-shipped types).

## 0.5.0 — 2026-07-26

### Added

Twenty-two new configuration types, taking the app well beyond firewall address
management into NAT, traffic management, threat inspection and user
authentication. All are name-keyed (profiles keyed by their `name`, shaping
profiles by `profile-name`) and upserted with `set`; reconcile only deletes
objects this app created (security-profile types additionally preserve
FortiManager built-ins); deploys/rollbacks run inside the ADOM workspace
transaction when enabled.

- **Firewall network objects**
  - **Firewall Virtual IPs** — IPv4 static-NAT / DNAT VIPs with optional
    single-port forwarding. `obj/firewall/vip`.
  - **Firewall VIP Groups** — named sets of member virtual IP objects.
    `obj/firewall/vipgrp`.
  - **Schedule Groups** — named sets of member one-time / recurring schedules.
    `obj/firewall/schedule/group`.
  - **Firewall IPv6 IP Pools** — overload source-NAT ranges (the IPv6 analog of
    Firewall IP Pools). `obj/firewall/ippool6`.
  - **Explicit-Proxy Addresses** — host-regex, url, method or ua matchers.
    `obj/firewall/proxy-address`.
  - **Explicit-Proxy Address Groups** — named sets of member proxy-address
    objects. `obj/firewall/proxy-addrgrp`.
  - **Firewall Multicast Addresses** — a multicast IP range or a broadcast
    subnet. `obj/firewall/multicast-address`.
- **Traffic shaping**
  - **Traffic Shapers** — shared shapers (guaranteed / maximum bandwidth,
    priority, DiffServ marking). `obj/firewall/shaper/traffic-shaper`.
  - **Per-IP Shapers** — per-source bandwidth and concurrent-session limits.
    `obj/firewall/shaper/per-ip-shaper`.
  - **Shaping Profiles** — ToS / queuing classes with per-class bandwidth
    guarantees (keyed by `profile-name`). `obj/firewall/shaping-profile`.
- **Internet Service (ISDB)**
  - **Custom Internet Services** — ISDB extensions with protocol / port-range /
    destination entries. `obj/firewall/internet-service-custom`.
  - **Custom Internet Service Groups** — named sets of member custom internet
    services. `obj/firewall/internet-service-custom-group`.
- **Security profiles**
  - **Application Control Profiles** — default actions plus per-category /
    application rules. `obj/application/list`.
  - **IPS Sensors** — signature filter entries plus botnet / malicious-URL
    controls. `obj/ips/sensor`.
  - **AntiVirus Profiles** — inspection mode, scan mode and per-protocol
    scanning behaviour. `obj/antivirus/profile`.
  - **Web Filter Profiles** — web filter security profiles.
    `obj/webfilter/profile`.
  - **DNS Filter Profiles** — DNS filter security profiles.
    `obj/dnsfilter/profile`.
  - **SSL/SSH Inspection Profiles** — SSL/SSH inspection security profiles.
    `obj/firewall/ssl-ssh-profile`.
- **User / authentication**
  - **User LDAP Servers** — LDAP authentication servers (bind password is
    write-only). `obj/user/ldap`.
  - **User RADIUS Servers** — RADIUS authentication servers (shared secrets are
    write-only). `obj/user/radius`.
  - **User FSSO Agents** — FSSO collector-agent connections (agent password is
    write-only). `obj/user/fsso`.
  - **User Groups** — named sets of members and auth servers. `obj/user/group`.

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
