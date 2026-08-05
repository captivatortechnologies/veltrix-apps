# FortiManager

Manage **Fortinet FortiManager** configuration as code through the FortiManager
**JSON-RPC API** (`/jsonrpc`), with validation, drift detection and rollback
handled by the Veltrix Security-as-Code pipeline.

## What it manages

All configuration types below are **name-keyed** (the FortiManager mkey, or
`profile-name` for shaping profiles) and reconciled the same way: list the
ADOM table, match declared items against it by name, **upsert with `set`**
(create-or-replace), and delete only objects a prior deploy of this app
created but no longer declares. When the ADOM is in **workspace mode**,
every deploy/rollback wraps its changes in a `lock` → change → `commit` →
`unlock` transaction.

| Group | Configuration type | FortiManager object (`/pm/config/adom/<adom>/obj/...`) |
| --- | --- | --- |
| Firewall addresses | Firewall Addresses | `firewall/address` |
| Firewall addresses | Firewall IPv6 Addresses | `firewall/address6` |
| Firewall addresses | Wildcard FQDNs | `firewall/wildcard-fqdn/custom` |
| Firewall addresses | Firewall Address Groups | `firewall/addrgrp` |
| Firewall addresses | Firewall IPv6 Address Groups | `firewall/addrgrp6` |
| Firewall addresses | Firewall Multicast Addresses | `firewall/multicast-address` |
| Explicit proxy | Explicit-Proxy Addresses | `firewall/proxy-address` |
| Explicit proxy | Explicit-Proxy Address Groups | `firewall/proxy-addrgrp` |
| Services & schedules | Firewall Services | `firewall/service/custom` |
| Services & schedules | Firewall Service Groups | `firewall/service/group` |
| Services & schedules | Recurring Schedules | `firewall/schedule/recurring` |
| Services & schedules | One-time Schedules | `firewall/schedule/onetime` |
| Services & schedules | Schedule Groups | `firewall/schedule/group` |
| NAT | Firewall IP Pools | `firewall/ippool` |
| NAT | Firewall IPv6 IP Pools | `firewall/ippool6` |
| NAT | Firewall Virtual IPs | `firewall/vip` |
| NAT | Firewall VIP Groups | `firewall/vipgrp` |
| Traffic shaping | Traffic Shapers | `firewall/shaper/traffic-shaper` |
| Traffic shaping | Per-IP Shapers | `firewall/shaper/per-ip-shaper` |
| Traffic shaping | Shaping Profiles | `firewall/shaping-profile` |
| Internet Service (ISDB) | Custom Internet Services | `firewall/internet-service-custom` |
| Internet Service (ISDB) | Custom Internet Service Groups | `firewall/internet-service-custom-group` |
| Security profiles | Application Control Profiles | `application/list` |
| Security profiles | IPS Sensors | `ips/sensor` |
| Security profiles | AntiVirus Profiles | `antivirus/profile` |
| Security profiles | Web Filter Profiles | `webfilter/profile` |
| Security profiles | DNS Filter Profiles | `dnsfilter/profile` |
| Security profiles | SSL/SSH Inspection Profiles | `firewall/ssl-ssh-profile` |
| User / authentication | User LDAP Servers | `user/ldap` |
| User / authentication | User RADIUS Servers | `user/radius` |
| User / authentication | User FSSO Agents | `user/fsso` |
| User / authentication | User Groups | `user/group` |

Grouping/composing types reference other types' objects by name — e.g.
Firewall Address Groups reference Firewall Addresses, Firewall IPv6 Address
Groups reference Firewall IPv6 Addresses, VIP Groups reference VIPs, Schedule
Groups reference one-time/recurring schedules, and User Groups reference the
LDAP/RADIUS/FSSO servers. Deploy those component types first (see the
Coverage section for the full audit of what this covers and what is
intentionally out of scope).

## Authentication

FortiManager authenticates with an **admin user** over JSON-RPC. Store the
credential as:

- **Username** → the FortiManager admin username
- **Password** → that admin's password

The app logs in via `exec sys/login/user` and reuses the returned session token
(re-logging in automatically if it expires). Set the FortiManager **Host** and
target **ADOM** (default `root`) in the app's settings; enable **Workspace mode**
if the ADOM uses workspace/workflow mode.

> **TLS note:** this app uses the standard TLS stack, so the FortiManager must
> present a certificate the host trusts (a valid CA chain or FortiManager Cloud).

## Coverage

What of the FortiManager JSON-RPC API's configuration-as-code surface this
app manages, versus what is intentionally excluded and why — audited against
the FortiManager JSON API reference (`how-to-fortimanager-api.readthedocs.io`),
Fortinet's own FortiManager Ansible collection (`fortinet.fortimanager`) module
docs, and the `pyfmg`/`fortimanager-ansible` JSON-RPC client source.

### Managed

All 32 types in the **What it manages** table above — every one of them lives
in the ADOM's **shared object database** (`/pm/config/adom/<adom>/obj/...`),
is identified by a stable **name** mkey, and is fully reconciled (create,
update, and delete-what-this-app-created) with the `get` / `set` / `delete`
JSON-RPC methods alone. That shared shape is exactly why all 32 can be
maintained uniformly by one small API client (`lib/fortimanager.ts`) and one
per-type `validate`/`deploy`/`rollback`/`driftDetect`/`healthCheck`/`getStatus`
handler set.

### Intentionally excluded

- **Firewall policy packages and policies**
  (`/pm/pkg/adom/<adom>`, `/pm/config/adom/<adom>/pkg/<pkg>/firewall/policy`) —
  unlike every object type above, a policy's real identity is its numeric
  `policyid`; `name` is a display field FortiManager does not enforce as a
  reconciliation key. Policies are also **ordered** (position matters for
  first-match semantics) and scoped to a package + install target, not the
  ADOM directly. Verified: the FortiManager JSON API guide's policy-package
  chapter and Fortinet's own `fortimgr_policy`/`fmgr_pkg_firewall_policy_obj`
  Ansible modules both resolve an existing policy by `policyid` (falling back
  to a `name`/match-filter lookup) and expose a **separate `move`
  before/after operation** for ordering — a materially different, heavier
  model than this app's uniform name-keyed `set` upsert. A future config type
  for policies is reasonable, but needs its own ordering + package-selection
  design, not a 32nd copy of the existing pattern.
- **Central SNAT** (`firewall/central-snat-map`) — the same
  package-scoped, `policyid`-keyed, ordered table as firewall policy (central
  SNAT rules are evaluated in sequence, like policies), for the same reason
  excluded above.
- **VPN (IPsec / SSL) tunnels and templates** — IPsec phase1/phase2 and
  SSL-VPN portals/settings are provisioned per managed device (or through
  FortiManager's VPN Manager, which itself builds phase1/phase2 + routing +
  policy objects together as one workflow), not as flat ADOM objects; they
  carry real network topology (local/remote gateway, interface bindings)
  this app's object model doesn't represent.
- **Device / provisioning templates and SD-WAN templates**
  (`pm/devprof`, CLI templates, `pm/wanprof`) — these are bound to and
  installed onto specific managed devices/model families, not upserted into
  the ADOM's shared object database; applying one is a device-provisioning
  workflow (assign → install), not an object CRUD call.
- **ADOMs themselves** (`/dvmdb/adom`) — ADOM create/delete is a
  platform/meta-administration action on the scope this app operates
  *inside* (the app's own `adom` setting selects one), not a resource
  *within* an ADOM.
- **FortiManager admin profiles and users**
  (`/cli/global/system/admin/user`, `/cli/global/system/admin/profile`) —
  managing the credentials/privileges of the very account class this app
  authenticates as is a distinct security-administration surface (who can
  reach FortiManager at all), deliberately out of scope for an app whose job
  is target-system configuration — the same boundary this repo's other
  network-management apps (e.g. Check Point) draw around their own admin
  accounts.
- **Dynamic (SDN-connector) objects and per-device metadata variables**
  (`dynamic/interface`, `dynamic/address`, `dvmdb` per-device metafields) —
  these resolve differently per managed device/SDN connector rather than
  having one flat, name-keyed value across the ADOM, so they don't fit this
  app's declarative object model without a device-scoping dimension none of
  the 32 shipped types need.
- **Policy installation, previews and revisions**
  (`/securityconsole/install/package`, `/securityconsole/install/preview`,
  ADOM revision create/restore) — one-off imperative actions against managed
  devices, not desired-state configuration; this app's `set`/`delete` calls
  only ever touch the ADOM object database, never install a policy package to
  a device.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs fortimanager

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/fortimanager
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
