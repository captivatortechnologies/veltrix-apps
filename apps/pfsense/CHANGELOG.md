# Changelog

All notable changes to the pfSense app are documented here.

## 0.3.0 — 2026-08-04

Exhausts the pfSense REST API package's remaining meaningful declarative
surface — ten more config types, each with typed per-field canvas forms
(never a raw JSON blob), dedicated handlers, and a full `node:test` suite,
matching Firewall Aliases' v0.1.0 foundation. Same package dependency as
every prior release — still a real, separate install step, still flagged
throughout.

- **NAT Outbound Mode** — a **singleton** config type for pfSense's
  system-wide outbound NAT mode (`/api/v2/firewall/nat/outbound/mode`,
  PATCH-only). Verified the Model's actual `choices` are
  `['automatic','hybrid','advanced','disabled']` — its own prose help text
  says "manual" instead of "advanced," a real mismatch this app resolves in
  favor of the verified `choices`, not the prose.
- **NAT Outbound Mappings** and **1:1 NAT Mappings** — `/api/v2/firewall/nat/outbound/mapping(s)`
  and `/api/v2/firewall/nat/one_to_one/mapping(s)`. Neither Model declares a
  unique field (verified), so both are tracked by canvas-item id, same
  pattern as Firewall Rules/NAT Port Forwards. Outbound Mappings additionally
  support the same optional `position` -> `placement` ordering. Both share
  `/api/v2/firewall/apply`.
- **Firewall Schedules** — `/api/v2/firewall/schedule(s)`, name-keyed. Each
  schedule embeds exactly ONE time range in this release — recurring
  weekdays OR specific month+day date pairs, never both (mutually exclusive
  per the API); multiple time ranges per schedule is flagged as out of
  scope. Replicates the package's own quirks faithfully rather than
  "fixing" them: the supported minute set is `00/15/30/45/59` (not every 15
  minutes), and February is hardcoded to 29 days in the day-in-month check
  regardless of leap year.
- **Gateways** and **Static Routes** — `/api/v2/routing/gateway(s)` (name-keyed,
  immutable name) and `/api/v2/routing/static_route(s)` (no name field,
  canvas-item-id tracked). Both apply via **`/api/v2/routing/apply`** — a
  THIRD distinct apply endpoint, verified shared by `RoutingGateway.inc` and
  `StaticRoute.inc` and separate from every firewall/virtual-IP endpoint.
  Gateways are scoped to core identity/monitoring fields; ~14 advanced
  dpinger tuning knobs are dropped (every one has a safe server-side default).
- **DNS Resolver Host Overrides** and **DNS Resolver Domain Overrides** —
  `/api/v2/services/dns_resolver/host_override(s)` and `.../domain_override(s)`.
  Host overrides key on the COMPOSITE `host`+`domain` pair (verified
  `unique_together_fields` — neither field alone is unique); domain
  overrides key on `domain`. Both share a **FOURTH** distinct apply
  endpoint, `/api/v2/services/dns_resolver/apply`. Host overrides' nested
  `aliases` sub-list (additional alias hostnames) is out of scope — every
  override this app writes has zero aliases.
- **Local Users** and **Local User Groups** — `/api/v2/user` and
  `/api/v2/user/group`, name-keyed. Both Models are `always_apply: true`
  server-side (verified) — every write applies immediately, so neither
  config type calls an apply endpoint at all, unlike every other type in
  this app. `password` is treated write-only in this app's own behavior
  (never diffed by drift or restored by rollback) even though the Model
  itself doesn't declare the field `write_only`. System-scoped accounts and
  groups (pfSense's own built-ins, e.g. `admin`) are never touched, matching
  what the package itself forbids deleting.
- **Coverage section added to README.md** — every pfSense REST API package
  surface, managed vs. explicitly excluded and why (Certificates/CAs need
  private-key material; VPN configuration needs key material and
  multi-resource activation; interfaces/VLANs/bridges are host-specific
  hardware topology; several services are themselves optional packages
  layered on the REST API package; system actions/diagnostics/status/logs
  are imperative or read-only, not declarative resources).
- Every new config type declares a sidebar `group` (`"NAT"`, `"Firewall"`,
  `"Routing"`, `"Services"`, or `"System"`).

> **FLAG**: this app deliberately does not attempt automatic outbound-NAT
> mode coordination — declaring Outbound NAT Mappings while Outbound NAT
> Mode is left at its default "Automatic" is valid but inert (pfSense
> ignores manual mappings in that mode); `validate` surfaces this as a
> warning, not an error, since the two config types are deployed
> independently and this app cannot assume deploy order.

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
