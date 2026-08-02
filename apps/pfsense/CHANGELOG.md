# Changelog

All notable changes to the pfSense app are documented here.

## 0.2.0 — 2026-08-02

Three more config types, all via the same REST API package dependency
flagged in v0.1.0 (still required — nothing here changes that).

- **Firewall Rules** config type — create / edit / delete pfSense firewall
  (filter) rules over `/api/v2/firewall/rule(s)`. Deliberately scoped to the
  core match/action fields (type, interface(s), floating, ipprotocol,
  protocol, source/destination + ports, descr, disabled, log, direction,
  quick, statetype) — advanced traffic-shaping/scheduling fields (dscp, tag,
  tcp_flags_*, gateway, sched, dnpipe/pdnpipe, defaultqueue/ackqueue,
  icmptype) are DROPPED for this release, flagged rather than
  half-implemented. `floating` is immutable after creation and never PATCHed.
  **Identity is tracked per canvas item** (rollbackData), not by name or
  description — pfSense rules have no unique/name field (verified against
  `RESTAPI/Models/FirewallRule.inc`). Supports an optional `position` field
  mapped to the REST API package's generic `placement` mechanism for
  ordering — see README.md for the full model and its deliberate limits.
- **NAT Port Forwards** config type — create / edit / delete pfSense NAT
  port-forward rules over `/api/v2/firewall/nat/port_forward(s)`, including
  `associated_rule_id` (require a separate rule / auto-create one / pass
  with no rule / link an existing rule). Same canvas-item identity tracking
  and optional `position` ordering as Firewall Rules, for the same reason
  (verified: `PortForward.inc` also declares no unique/name field).
- **Virtual IPs** config type — create / edit / delete pfSense virtual IPs
  (IP Alias / Proxy ARP / CARP / Other) over `/api/v2/firewall/virtual_ip(s)`.
  **Identity is the VIP's own unique `subnet` address** (verified `unique:
  true`) — matches Firewall Aliases' name-keyed pattern. **Uses its own
  separate apply endpoint**, `/api/v2/firewall/virtual_ip/apply` — verified
  that virtual IPs are NOT part of the shared `/api/v2/firewall/apply`
  subsystem list (`FirewallApply::FIREWALL_SUBSYSTEMS` has no `'vip'`).
- **Shared validation library** extracted to `config-types/lib/pfsenseShared.ts`
  (IP/CIDR/FQDN matchers, port/port-range checks, filter-address and
  NAT-target shape checks) — reused by all four config types instead of
  duplicated per type, mirroring this codebase's Check Point
  `config-types/lib/checkpointShared.ts`. Firewall Aliases' `_shared.ts` was
  refactored to import from it (behavior-preserving — all existing tests
  pass unchanged).
- **`lib/pfsenseApi.ts`** gained a generic `buildCrudOps()` factory (mirrors
  Cisco ISE's `buildErsResourceClient`) so every resource's create/update/
  delete/list follows one implementation; Firewall Aliases' methods were
  refactored onto it with no external signature changes.
- Every config type now declares a sidebar `group` (`"Firewall"` for
  aliases/rules/virtual-ips, `"NAT"` for port forwards).

> **Ordering, handled honestly.** Verified against `RESTAPI/Core/Model.inc`'s
> generic `set_placement()`: any `many`-enabled resource accepts an optional
> `placement` field (a 0-based, GLOBAL array index) on create/update — the
> same mechanic pfSense's own GUI drag-and-drop reordering uses. This app
> exposes it as an optional `position` field on Firewall Rules and NAT Port
> Forwards; left blank, a new rule simply appends at the end and an existing
> one is never silently reordered. It deliberately does NOT auto-derive
> placement from canvas item order — doing so safely (without risking
> reshuffling rules this app does not manage) is a harder problem than a
> single per-item `placement` write can solve, and this release does not
> attempt it. FLAGGED, not glossed over.
>
> **FLAG**: `FirewallRule.inc` never calls `mark_subsystem_dirty('filter')`
> (verified — no such call anywhere in the class), so the shared apply
> endpoint's `pending_subsystems` status may under-report a pending rule
> change. Does not affect correctness: this app always calls
> `POST /api/v2/firewall/apply` unconditionally, and
> `FirewallApplyDispatcher` reloads the filter unconditionally regardless of
> any dirty flag (verified).

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Firewall Aliases** config type — create / edit / delete pfSense firewall
  aliases (host / network / port groups: `name`, `type`, `descr`, `address[]`,
  `detail[]`) over the third-party **pfSense REST API package**
  (pfSense-pkg-RESTAPI, `/api/v2/firewall/alias(es)`), with validate / deploy
  (upsert by alias name) / rollback (restore prior fields or delete created)
  / health-check / drift-detect / status. Pending changes are applied once
  per deploy (and once per rollback) via `/api/v2/firewall/apply`, not once
  per alias.
- **Connectivity test** against the REST API package (`GET
  /api/v2/system/version`), auto-detecting API-key vs. JWT auth from
  whichever secret the connection's credential carries, self-signed TLS
  tolerated.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (install
  the REST API package → choose an auth method → credential → connection),
  and Connections (wraps the SDK `ConnectionsManager` for a pfSense firewall;
  saving a connection registers `pfsense` as a deploy target).

> **pfSense ships no REST API of its own.** This app depends on the
> third-party pfSense REST API package (pfSense-pkg-RESTAPI, formerly
> jaredhendrickson13/pfsense-api) being installed on the target firewall
> first — a real, separate install step (System > Package Manager >
> Available Packages > "RESTAPI"), not something already running. Chosen
> over pfSense Plus's newer official Netgate API because it works on both CE
> and Plus and is the de-facto community standard. Every API fact (response
> envelope, auth headers/endpoints, alias field set and validation rules,
> the apply/pending-changes model) was verified directly against the
> package's PHP source (`RESTAPI/Models/FirewallAlias.inc`,
> `RESTAPI/Core/Response.inc`, etc.) and pfSense's own
> `is_validaliasname()`/`is_port_or_range()` — see README.md and
> `lib/pfsenseApi.ts` for citations. An alias's `name` is immutable once
> created; pfSense's full reserved-name set is dynamic (depends on the box's
> configured interfaces) and only partially checkable client-side — flagged
> as a warning, not faked as a hard rule. TLS verification is off by default
> (self-signed) and configurable via the `verify_tls` setting.
