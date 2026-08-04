# Changelog

All notable changes to the OPNsense app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-03

This release exhausts OPNsense's config-as-code write surface as far as it
can safely go — every remaining meaningful, cleanly-writable API surface is
now managed, and everything left out has a documented, verified reason (see
README.md's new **Coverage** section). `lib/opnsenseApi.ts` was split into
`lib/opnsenseCore.ts` (transport + the generic `buildModelResource` factory +
the two "apply" idioms) plus one file per API family, purely for file size —
every existing import path is unchanged (`lib/opnsenseApi.ts` is now a
re-export barrel).

### Added
- **1:1 NAT (`one-to-one-nat`, group "NAT").** `onetoone.rule` on the SAME
  shared Filter.xml model as firewall-rules/source-nat, via
  `/api/firewall/one_to_one` (`addRule`/`setRule`/`delRule`/`apply`).
  **REQUIRES OPNsense 24.1.9 (June 18, 2024) or later** — more precise than
  firewall-rules/source-nat's 24.1 floor: verified `OneToOneController.php`'s
  own git history (oldest commit `cd81bcc9`, 2024-04-25, "refactor to MVC")
  and pinned to an exact release via the official changelog
  (`community/24.1/24.1.9`: "the last bit of preparation for the upcoming
  24.7 series reimplementing one-to-one NAT using MVC/API"). Itemid-based
  reconcile, same as firewall-rules/source-nat (no name field).
- **Unbound host overrides (`unbound-host-overrides`, group "Services").**
  `hosts.host` via `/api/unbound/settings` (`addHostOverride`/
  `setHostOverride`/`delHostOverride`), reconciled by the (hostname, domain)
  composite. Supports A/AAAA/MX/TXT records with the model's own per-type
  required-field constraints replicated client-side. Applies via
  `/api/unbound/service/reconfigure`, which — per
  `ApiMutableServiceControllerBase`'s default — STOPS THEN STARTS the Unbound
  resolver (a brief DNS gap, not a soft reload).
- **Unbound domain overrides (`unbound-domain-overrides`, group "Services").**
  Mapped onto `dots.dot` with `type: "forward"` — verified there is NO
  separate endpoint for the legacy "Domain Override" concept in the current
  MVC model; `addForwardAction`/`setForwardAction` force `type: "forward"`
  via their own overlay regardless of what's sent, so this config type can
  only ever create/manage plain forwards, never DNS-over-TLS entries (and
  will silently downgrade a hand-configured DNS-over-TLS entry sharing the
  same domain — documented, not hidden). Same apply step as host overrides.
- **Traffic-shaper pipes/queues/rules (`traffic-shaper-pipes`,
  `traffic-shaper-queues`, `traffic-shaper-rules`, group "Traffic Shaping").**
  Three config types over ONE shared `TrafficShaper.xml` model
  (`/api/trafficshaper/settings`, verb sets verified against
  docs.opnsense.org's own endpoint tables: singular add/set/del, PLURAL
  search — `searchPipes`, not `searchPipe`). Pipes/queues use their
  model-required `description` as a natural identity; rules (no required
  name) use the canvas item's own id, like firewall-rules. Queues/rules
  declare their target pipe (or pipe-or-queue, for rules) by NAME and resolve
  it to a live uuid at deploy time. The pf dnpipe/queue `number` is
  SERVER-ASSIGNED (an `addBase` overlay) and never set by this app. Applies
  via `/api/trafficshaper/service/reconfigure` (reloads the Shaper and IPFW
  templates, then `shaper reload` + `ipfw reload`).
- **Static routes (`static-routes`, group "Routing").** `route` (a top-level
  array, not nested under a sub-container like every other resource in this
  app) via `/api/routes/routes`. Verified GENUINELY all-lowercase, no-
  camelCase action names (`searchroute`/`addroute`/`setroute`/`delroute`) —
  the literal PHP method names on `RoutesController`, confirmed independently
  against docs.opnsense.org's own endpoint table. Reconciled by `network`
  (the model's field is `descr`, not `description` — the one resource in this
  app where that differs). `gateway` is a name from OPNsense's own configured
  gateway list, passed through as-is (not enumerable offline). Applies via
  `/api/routes/routes/reconfigure` (`interface routes configure`) — the
  actual OS routing-table delete is deferred server-side to a
  `/tmp/delete_route_<uuid>.todo` marker file this app never touches directly.
- **`buildModelResource` verb-naming verified against docs.opnsense.org's own
  API reference tables** (not just PHP source reading) for every module in
  this app — confirming, among other things, that OPNsense's official docs
  spell commands in underscore_case (`add_pipe`, `search_rule`) while this
  app's camelCase (`addPipe`, `searchRule`) is the byte-identical equivalent
  under the router's `ucwords`/`lcfirst` transform (see
  `lib/opnsenseCore.ts`'s URL-segment-derivation doc) — and that the
  Destination NAT (port forward) module segment is `d_nat` (with an
  underscore), not `dnat`, useful for a future wave.

### Coverage — see README.md for the full table
Every OPNsense config-as-code surface this app could plausibly reach was
evaluated. See README.md's new **Coverage** section for the complete
managed-vs-excluded breakdown; summarized:
- **Excluded, structurally (drop, don't fake):** WireGuard server/peer
  configuration (`Server.xml`'s `privkey` is `Required: Y` with no
  credential-vault-backed way to reference an existing key — see below),
  certificates/CAs (private key material), interface/hardware assignment,
  and system actions (firmware upgrade, reboot, backup/restore) — none of
  these are "configuration as code" in the sense this app's pipeline model
  (validate → deploy → drift → rollback) is built for.
- **Not yet built, but cleanly buildable (future work, not excluded):**
  Unbound ACLs/DNSBL/host-aliases/DoT entries, Destination NAT (port
  forward — see the "Why Source NAT, not 1:1 NAT or Port Forward" note in
  v0.2.0's entry below for why it was skipped, not just deferred), NPTv6,
  IPsec, OpenVPN, DHCP (Kea/ISC), gateway groups, and Category-reference
  support on `firewall-aliases` (added for rules/NAT in v0.2.0, not
  retrofitted onto aliases).

### Dropped, with full reasoning: WireGuard
WireGuard (`/api/wireguard/{server,client}/*`) was evaluated and NOT built.
Verified: `Server.xml`'s `privkey` field (`Base64Field`) is `<Required>Y</Required>`
— a WireGuard server literally cannot be created without a private key.
`ServerController::keyPairAction()` generates one server-side
(`wireguard gen_keypair`), but persisting it means the private key would
have to transit through this app's canvas configuration and `rollbackData`
— neither is a Credential-Vault-backed secret store, and this codebase
avoids embedding fetchable/usable secrets in declarative config everywhere
else (see the URL-Table-authentication drop in `firewall-aliases`, v0.1.0).
Client (peer) records additionally carry a `psk` (pre-shared key) and
require bidirectional Server<->Client `peers` CSV-field synchronization
(`ClientController::setClientAction` rewrites every Server's `peers` field
on every peer add/remove) — real complexity, but secondary to the primary,
disqualifying blocker above.

## 0.2.0 — 2026-08-02

### Added
- **Firewall categories (`firewall-categories`).** Pure metadata tags managed
  through `addItem` / `setItem` / `delItem` against `/api/firewall/category`,
  reconciled by name against `searchItem`. Categories have NO live pf effect
  (verified: no apply/reconfigure action exists on `CategoryController`), so
  this config type's deploy has no apply step at all — staging is the whole
  deploy. System-managed categories (`auto: "1"`, e.g. an Anti-Lockout
  category some NAT versions auto-create) are never created, updated or
  deleted by this app. Oldest of the app's resources — the model has shipped
  in core since January 2021, so there is no meaningful version floor.
- **Firewall rules (`firewall-rules`).** Pf rules managed through `addRule` /
  `setRule` / `delRule` against `/api/firewall/filter`. **REQUIRES OPNsense
  24.1 "Savvy Shark" (released January 30, 2024) or later** — the Firewall
  Automation filter API shipped in core starting with 24.1, formerly a
  separately-installed "os-firewall" plugin (verified two ways: the official
  24.1 changelog, and the exact core commit — `8e299d3e`, 2024-01-07 — that
  introduced `FilterController.php`/`FilterBaseController.php`/
  `SourceNatController.php` together). On an un-upgraded pre-24.1 box, every
  endpoint 404s. A pf rule has NO name field, so this config type reconciles
  by the CANVAS ITEM's own stable id (tracked to the OPNsense-assigned uuid
  in `rollbackData`), not by name. Rule ordering is handled honestly:
  `sequence` only orders rules WITHIN the automatically-computed
  floating/interface-group/single-interface bucket a rule falls into based on
  its own interface selection (verified against
  `FilterRuleField::actionPostLoadingEvent()`/`getPriority()`) — this app
  does not replicate the UI's drag-and-drop gap-renumbering. Rules can
  reference `firewall-categories` by name, resolved to their live uuid at
  deploy time. Every deploy that touches a rule finishes with one
  `/api/firewall/filter/apply` call.
- **Source NAT / outbound NAT (`source-nat`).** Outbound NAT rules managed
  through `addRule` / `setRule` / `delRule` against
  `/api/firewall/source_nat`. Same OPNsense 24.1+ requirement as
  firewall-rules (`SourceNatController.php` was added in the identical core
  commit) and the same itemId-based reconcile (no name field on
  `snatrules.rule` either). **Mode gate, surfaced not silently ignored:**
  manually-declared rules only take effect on the wire when OPNsense's
  system-wide Outbound NAT mode is Hybrid or Manual — in the default
  Automatic mode (or Disabled), declared rules stage and apply successfully
  but have ZERO real effect. This app does not change that global setting;
  it reads it (`getSourceNatMode`) and surfaces a prominent warning in the
  deploy message and as a `healthCheck` item instead. Every deploy that
  touches a rule finishes with one `/api/firewall/source_nat/apply` call —
  verified to run the exact same backend reload as firewall-rules' `apply`
  (`SourceNatController` extends `FilterBaseController` and does not
  override `applyAction`).
- **Generic mutable-model resource factory (`lib/opnsenseApi.ts`).**
  Refactored the alias-specific `addItem`/`setItem`/`delItem`/`searchItem`
  calls onto one shared `buildModelResource()` factory (mirroring this
  codebase's Cisco ISE `buildErsResourceClient` pattern) so categories, filter
  rules and source NAT rules reuse the exact same verified CRUD envelope
  instead of duplicating it — including the "Item" vs "Rule" action-verb
  naming split between `ApiMutableModelControllerBase`'s own default names
  and `FilterController`/`SourceNatController`'s overridden ones. Every
  exported alias function (`searchAliases`, `addAlias`, `setAlias`,
  `deleteAlias`) keeps its exact v0.1.0 signature — zero changes needed to
  `firewall-aliases`' handlers.
- **`group:` on every configuration type.** `firewall-aliases` and
  `firewall-categories` are grouped under "Firewall" in the sidebar;
  `firewall-rules` is also "Firewall"; `source-nat` is grouped under "NAT".

### Not modeled in v0.2.0 (flagged, not faked)
- **Firewall rules** drop `state-policy`, `divert-to`/`gateway`/`replyto`/
  `disablereplyto` (advanced routing), `allowopts`/`nosync`/`nopfsync` and
  every state-table tuning knob (`statetimeout`, `udp-*`, `max*`,
  `adaptivestart`/`adaptiveend`), `overload` (alias table-overload relation),
  `prio`/`set-prio`/`set-prio-low` (QoS marking), `tag`/`tagged` (pf packet
  tagging), `tcpflags1`/`tcpflags2`/`tcpflags_any`, `icmptype`/`icmp6type`,
  `sched` (time-based schedules — needs its own config type/lookup) and
  `shaper1`/`shaper2` (traffic-shaper pipe/queue relations — a cross-module
  dependency this app doesn't model). The deprecated `inet46` "any" IP
  version is excluded — Filter.xml's own source comment marks it `XXX remove
  when filter.lib.inc use is removed`.
- **Source NAT** drops `nosync` and `tag`/`tagged` for the same reasons.
- **1:1 NAT and NPTv6** (`onetoone.rule` / `npt.rule` — the same shared
  Filter.xml model backs them) were evaluated and NOT built this release:
  their API controllers only got a "refactor to MVC" much more recently
  (`OneToOneController.php` April 2024, still receiving structural changes as
  late as December 2025) than the well-established, actively-maintained
  Source NAT surface (live since the original January 2024 import, with an
  outbound-NAT-to-Source-NAT config migration shipped as recently as June
  2026) — Source NAT was the safer, better-verified choice for this release.
- **Port Forward / Destination NAT** (`DNatController.php`) was evaluated and
  explicitly DROPPED for this release: its Firewall Automation MVC/API
  conversion only landed in core on **2025-12-02** (`Firewall: NAT: Port
  Forward - refactor to MVC`, PR #9473) — under a year old as of this
  writing, with substantial follow-on churn since (anti-lockout rules in
  December 2025, a `ProtocolField` special-case fix in January 2026, further
  UI/behavior changes through July 2026). That combination of a very recent
  version floor and high change velocity made it a materially higher
  correctness risk than Source NAT for this release.
- **Firewall-aliases still does not reference `firewall-categories`** — that
  cross-reference was added for `firewall-rules`/`source-nat` only in this
  release. Retrofitting it onto aliases is a natural, low-risk follow-up.

## 0.1.0 — 2026-08-02

### Added
- **Firewall aliases (`firewall-aliases`).** Manage OPNsense firewall alias
  objects as code through `addItem` / `setItem` / `delItem` against
  `/api/firewall/alias`, reconciled by alias name against `searchItem`.
  Missing aliases are created, existing aliases are updated to the declared
  spec (type, content, description, enabled state, protocol filter, tracked
  interface, URL-table refresh frequency), and aliases this app previously
  created but no longer declares are removed. Supports 11 of OPNsense's 13
  alias types — host, network, port, URL, URL Table, URL Table (JSON), GeoIP,
  network group, MAC address, BGP ASN and Dynamic IPv6 Host (`authgroup`,
  `internal` and `external` are scoped out — see "Not modeled" below). Ships
  the full handler set (validate, deploy, rollback, healthCheck, driftDetect,
  getStatus).
- **Stage-then-apply deploy model.** `addItem`/`setItem`/`delItem` only stage
  a change into OPNsense's pending configuration; every deploy/rollback that
  touches at least one alias finishes with a single `reconfigure` call, which
  is the step that actually reloads the pf filter/alias tables. A failure
  partway through a batch leaves whatever was already staged in the pending
  configuration but never calls `reconfigure`, so nothing reaches the running
  firewall — rollback can still cleanly undo the staged part from the
  recorded `rollbackData`.
- **API client (`lib/opnsenseApi.ts`).** A from-scratch REST client for
  `https://<host>[:port]/api/<module>/<controller>/<command>`: HTTP Basic
  auth with the API key in the username position and secret in the password
  position, JSON request/response handling, and a self-signed-tolerant
  `node:https` Agent gated by the "Verify TLS certificate" setting (off by
  default, matching OPNsense's own shipped default).
- **Connection test.** `GET /api/core/firmware/status` — verifies the host,
  TLS trust setting and API key/secret pair without staging or applying any
  firewall change.

### Not modeled in v0.1.0 (flagged, not faked)
- **`authgroup` aliases** (OpenVPN group lists) are not offered — their
  content is a list of numeric group ids resolved through OPNsense's local
  user-group system, which this app has no way to look up or validate yet.
- **`internal`/`external` alias types** are excluded from the type picker —
  `internal` is reserved for aliases OPNsense creates for itself (bogons,
  sshlockout, ...), and `external` references an externally managed pf table;
  neither is something a client legitimately authors.
- **URL Table authentication** (`username`/`password`/`authtype`: Basic /
  Bearer / Header) is a real field set on the model, but storing a fetch
  credential inside a canvas configuration is a pattern this codebase avoids
  elsewhere. A future credential-backed extension is the right home for it.
- **`expire`** (Dynamic IPv6 Host TTL) and **`categories`** (a relation to
  Firewall Category objects) are real fields dropped to keep this a
  self-contained object with no dependency on another config type.
- Country-code (GeoIP) and reserved protocol/service-name checks that need
  OPNsense's own data files (`tzdata-iso3166.tab`, `/etc/services`) are
  format-checked client-side (2-letter code or "EU") but the exhaustive list
  is left to OPNsense's own validation response.
