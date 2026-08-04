# 🚦 pfSense

Manage [pfSense](https://www.pfsense.org/) firewall configuration as code on
the Veltrix Security-as-Code platform. Author configuration in the
Configuration Canvas and drive it through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status).

## Requirements — a REST API package is a real install step

**pfSense CE (and Plus) ship no REST API of their own.** This app talks to
the widely-used, independently maintained third-party package
**[pfSense-pkg-RESTAPI](https://github.com/pfrest/pfSense-pkg-RESTAPI)**
(formerly `jaredhendrickson13/pfsense-api`; docs at
[pfrest.org](https://pfrest.org/)) — **you must install it on every pfSense
box this app manages** before anything here works:

> **System > Package Manager > Available Packages** → search **"RESTAPI"** → Install

Until it's installed, every request this app makes fails with **HTTP 404** —
that is the signal something is missing, not a bug in this app. See the
in-app Setup Guide for the full walkthrough.

### Why the third-party package, not pfSense Plus's official API?

pfSense Plus (Netgate) has a newer, official REST API, but it is
**Plus-only** — a customer running pfSense CE (the free, community edition)
cannot use it. The third-party package works on **both** CE and Plus, is the
de-facto community standard (versioned releases tracking each pfSense
release, built-in Swagger/OpenAPI docs, active maintenance), and is FOSS —
every fact this app relies on was verified directly against its PHP source,
not guessed from prose documentation.

## How it's managed

This app targets the package's **v2** API (base path `/api/v2` — configurable
via the `api_base_path` setting for forward compatibility, though only v2 is
implemented/tested):

- **Response envelope** — every response is
  `{ code, status, response_id, message, data }`
  (verified against `RESTAPI/Core/Response.inc`).
- **Two auth methods, auto-detected** — no separate "auth method" setting;
  whichever secret the connection's credential carries decides:
  - An **API key** (`apiToken`) → sent as `X-API-Key: <key>` on every request.
    Generate one in the webConfigurator (**System > REST API > Keys**) or via
    `POST /api/v2/auth/key`.
  - A **local webConfigurator username + password** (no API key set) → this
    app calls `POST /api/v2/auth/jwt` with HTTP Basic to mint a short-lived
    JWT (default 1h) and sends `Authorization: Bearer <token>` thereafter.
    LDAP/RADIUS-backed accounts are **not** supported for this by the
    package itself.
- **Self-signed TLS tolerated** — pfSense ships a self-signed certificate on
  the webConfigurator (which the REST API package shares) until an
  administrator installs a CA-signed one; the transport accepts it unless the
  `verify_tls` setting is turned on.

References:
[pfSense-pkg-RESTAPI (GitHub)](https://github.com/pfrest/pfSense-pkg-RESTAPI),
[pfrest.org docs](https://pfrest.org/),
[Authentication & Authorization](https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/).

## Configuration types

| Type | Surface | Identity | Status |
|---|---|---|---|
| **Firewall Aliases** | `/api/v2/firewall/alias(es)` + `/api/v2/firewall/apply` | `name` (unique) | ✅ v0.1.0 |
| **Firewall Rules** | `/api/v2/firewall/rule(s)` + `/api/v2/firewall/apply` | canvas item id | ✅ v0.2.0 |
| **NAT Port Forwards** | `/api/v2/firewall/nat/port_forward(s)` + `/api/v2/firewall/apply` | canvas item id | ✅ v0.2.0 |
| **Virtual IPs** | `/api/v2/firewall/virtual_ip(s)` + `/api/v2/firewall/virtual_ip/apply` | `subnet` (unique) | ✅ v0.2.0 |
| **Outbound NAT Mode** | `/api/v2/firewall/nat/outbound/mode` (singleton) + `/api/v2/firewall/apply` | singleton | ✅ v0.3.0 |
| **Outbound NAT Mappings** | `/api/v2/firewall/nat/outbound/mapping(s)` + `/api/v2/firewall/apply` | canvas item id | ✅ v0.3.0 |
| **1:1 NAT Mappings** | `/api/v2/firewall/nat/one_to_one/mapping(s)` + `/api/v2/firewall/apply` | canvas item id | ✅ v0.3.0 |
| **Firewall Schedules** | `/api/v2/firewall/schedule(s)` + `/api/v2/firewall/apply` | `name` (unique) | ✅ v0.3.0 |
| **Gateways** | `/api/v2/routing/gateway(s)` + `/api/v2/routing/apply` | `name` (unique, immutable) | ✅ v0.3.0 |
| **Static Routes** | `/api/v2/routing/static_route(s)` + `/api/v2/routing/apply` | canvas item id | ✅ v0.3.0 |
| **DNS Resolver Host Overrides** | `/api/v2/services/dns_resolver/host_override(s)` + `/api/v2/services/dns_resolver/apply` | `host`+`domain` (composite) | ✅ v0.3.0 |
| **DNS Resolver Domain Overrides** | `/api/v2/services/dns_resolver/domain_override(s)` + `/api/v2/services/dns_resolver/apply` | `domain` | ✅ v0.3.0 |
| **Local Users** | `/api/v2/user` (writes apply immediately) | `name` (unique) | ✅ v0.3.0 |
| **Local User Groups** | `/api/v2/user/group` (writes apply immediately) | `name` (unique) | ✅ v0.3.0 |

A firewall alias is pfSense's named host/network/port group, referenced by
firewall rules and NAT — verified against
`RESTAPI/Models/FirewallAlias.inc`:

- **Identity**: the alias `name` — **immutable once created** (the field is
  declared `editable: false`); renaming means deleting the old alias and
  creating a new one, which is exactly what happens if you rename an item in
  the canvas (the old name is removed, the new name is created).
- **Endpoints**: `GET/POST/PATCH/DELETE /api/v2/firewall/alias` for a single
  alias (by `id`, an internal array index — never guess or persist one
  yourself; this app always resolves it by listing/matching on `name`
  first). `GET /api/v2/firewall/aliases` lists **every** alias with its FULL
  representation in one call (no separate per-item detail fetch needed,
  unlike some session-based siblings in this codebase).
- **Fields**: `type` (`host` | `network` | `port`, required), `descr`
  (optional, ≤1024 chars), `address` (an array — content shape depends on
  `type`: IPs/FQDNs for `host`, CIDRs/FQDNs for `network`, ports/ranges for
  `port`; any entry may also reference another alias's name, nesting it),
  and `detail` (an array of optional descriptions, positionally paired with
  `address` — pfSense auto-fills a placeholder for any address left without
  one, but rejects more `detail` entries than `address` entries).
- **Apply semantics**: pfSense (like most firewalls) separates "write to
  config" from "reload the packet filter." This app writes every alias
  change first, then calls `POST /api/v2/firewall/apply` **once** per deploy
  (and once per rollback) — not once per alias — to avoid reloading the
  filter N times in a row.
- **Name validation** mirrors pfSense's own `is_validaliasname()`
  (`src/etc/inc/util.inc`): letters/digits/underscore only, ≤31 characters,
  not purely numeric or underscores, not the reserved words `port`/`pass`,
  not starting with `pkg_`. pfSense's **full** reserved-name set is
  **dynamic** (it also blocks every configured interface's name via
  `get_pf_reserved()`), which a schema-only `validate` step cannot see — a
  best-effort, non-exhaustive list of common collisions (`wan`, `lan`,
  `sshguard`, `openvpn`, ...) is surfaced as a **warning**, not a hard error;
  the REST API package remains the final authority.

**Identity is case-sensitive** — `WebServers` and `webservers` are two
distinct, independently valid pfSense aliases (the name charset check is
case-preserving), unlike some other apps in this codebase that fold case for
object identity. See `_shared.ts`'s `aliasKey` doc.

### Firewall Rules and NAT Port Forwards — identity, since there's no name field

Verified against `RESTAPI/Models/FirewallRule.inc` and
`RESTAPI/Models/PortForward.inc`: **neither Model declares a unique or
name-like field** — `descr` is free-text, not `unique: true`. Matching
live objects by `descr` the way aliases match by `name` would be unsafe (two
rules can legitimately share, or lack, a description). Instead, both config
types track identity by the **canvas item's own stable id**, recorded in
`rollbackData` across deploys — the pattern the SDK's own
`DeploymentSummary.rollbackData` doc describes for exactly this situation
("the external ids it assigned per canvas item ... instead of by name"). A
practical consequence: renaming/re-describing a rule in the canvas updates
the SAME live rule in place (matched by its tracked id), rather than being
mistaken for a totally different rule the way a name change would be for
aliases. `descr` is still strongly recommended for GUI/audit readability —
it just isn't the identity key.

### Ordering — `position` / `placement`, and its real limits

Verified against `RESTAPI/Core/Model.inc`'s generic `set_placement()`: **any**
`many`-enabled resource in this package (aliases, rules, port forwards,
virtual IPs alike) accepts an optional `placement` field (a 0-based array
index) on create/update — it splices the object out of its current position
and re-inserts it at `placement`, exactly like pfSense's own GUI drag-and-drop
reordering. There is **no** "insert after id X" convenience — it is a raw
index, and for firewall rules / NAT port forwards that index is **global**
across the box's ENTIRE rule list (every interface plus floating rules
together, not just the rule's own interface).

This app exposes it as an optional `position` field on **Firewall Rules**
and **NAT Port Forwards** (rule evaluation order matters for both), passed
straight through as `placement`:

- Left **blank** (the default): a new rule is appended at the end, and an
  existing rule is left exactly where it already is. Nothing is silently
  reordered.
- Set explicitly: the rule is moved/inserted at that global index —
  **including ahead of or behind rules this app does not manage.**

**FLAGGED, not glossed over**: this app deliberately does **not** try to
auto-derive `placement` from the canvas's own item order. Doing so naively
(`placement = index among this canvas's items`) would assign absolute
positions `0, 1, 2, ...` and could silently shuffle whatever unrelated rules
already occupy those slots. Doing it *safely* — preserving relative order
among only the rules THIS canvas declares, correctly, even as unmanaged
rules are added/removed by someone else between deploys — is a harder
problem than a single `placement` write per item can solve, and v0.2.0 does
not attempt it. Use the explicit `position` field when you need precise
control; leave it blank otherwise.

The `tracker` field on `FirewallRule` is unrelated to ordering — it is a
read-only, auto-generated unix-time tracking id (used to pair a NAT port
forward with its associated filter rule), not a position value.

### Virtual IPs — a SEPARATE apply endpoint

Verified against `RESTAPI/Models/VirtualIP.inc` / `VirtualIPApply.inc`:
virtual IPs are cleanly writable over the same CRUD conventions as every
other resource here, but they are **not** part of the shared apply
endpoint's subsystem list (`FirewallApply::FIREWALL_SUBSYSTEMS = ['aliases',
'natconf', 'filter', 'shaper']` — no `'vip'`). They have their **own** apply
endpoint, `POST /api/v2/firewall/virtual_ip/apply` (backed by
`VirtualIPApplyDispatcher`, not `FirewallApplyDispatcher`). Calling the
general `/api/v2/firewall/apply` does **not** apply pending virtual-IP
changes — this app calls the correct endpoint for each resource
automatically, so no action is needed, but it is a real, easy-to-miss
distinction if you're extending this app or the API package's Swagger docs
directly.

CARP mode's `password` field (the shared VHID group secret) is treated as
write-only in spirit: it is never diffed by drift detection and is not
guaranteed to be echoed back verbatim by a restored rollback.

### FLAG — FirewallRule's own dirty-tracking gap

Verified: `FirewallRule.inc` never calls pfSense's native
`mark_subsystem_dirty('filter')` (no `$this->subsystem` assignment
anywhere in the class, unlike `PortForward.inc`, which sets
`subsystem = 'natconf'`). This means `GET /api/v2/firewall/apply`'s
`pending_subsystems` status **may under-report** a pending rule change. It
does not affect correctness here — this app always calls
`POST /api/v2/firewall/apply` unconditionally after a write rather than
relying on that status, and `FirewallApplyDispatcher::_process()` (verified)
calls `filter_configure()`/`filter_configure_sync()` **unconditionally**,
regenerating the live ruleset from config regardless of any dirty flag.

## Notes

- **Port ranges use a colon, not a hyphen** (`8000:8100`, per pfSense's own
  `is_portrange()`) — a common mistake when porting rules from other
  firewalls.
- Client-side address validation (aliases' `address`, and firewall-rules'/
  NAT-port-forwards' `source`/`destination`/`target`) optimistically accepts
  any alias- or interface-name-shaped token as a possible live reference this
  app cannot verify without a connection (nested alias, service name,
  interface, or a NAT target's alias) — the REST API package is authoritative
  and will reject an unresolvable reference at deploy time. The one
  deliberate exception: a NAT port forward's `target` field explicitly
  rejects the literal keywords `any`/`(self)`/`l2tp`/`pppoe` even though they
  share that same generic token shape, because the underlying `SpecialNetworkField`
  disables all four (`allow_any`/`allow_self`/`allow_l2tp`/`allow_pppoe:
  false`) and typing one there is overwhelmingly more likely to be a mistake
  (carried over from a rule's source/destination field, where they ARE valid)
  than an actual alias coincidentally named `l2tp` — see
  `config-types/lib/pfsenseShared.ts`'s `isValidNatTarget` doc.
- Low-level validation primitives (IP/CIDR/FQDN matchers, port/port-range
  checks, filter-address and NAT-target shape checks) live in
  `config-types/lib/pfsenseShared.ts`, shared by every config type — not
  duplicated per type — mirroring this codebase's Check Point
  `config-types/lib/checkpointShared.ts`.
- TLS verification is off by default (self-signed) and configurable via the
  `verify_tls` setting.

Apache-2.0.

### NAT Outbound Mode / Mappings, 1:1 NAT, Schedules, Gateways, Static Routes, DNS Resolver, Users/Groups (v0.3.0)

- **NAT Outbound Mode** is a **singleton** (`repeatable: false`, like a settings
  form) — declare it once per canvas. `automatic` mode makes the separate
  **NAT Outbound Mappings** config type a no-op; use `hybrid` or `advanced`
  for mappings to take effect. Verified: `OutboundNATMode.inc`'s actual
  `choices` array is `['automatic','hybrid','advanced','disabled']` — its own
  prose help text says "manual" instead of "advanced", a real mismatch in the
  package's docstring; this app uses the verified `choices`, not the prose.
- **NAT Outbound Mappings** and **1:1 NAT Mappings** have no name field
  (verified) — tracked by canvas-item id, same pattern as Firewall Rules.
  Outbound Mappings additionally support the same optional `position` ->
  `placement` ordering as Firewall Rules/NAT Port Forwards. Both share
  `/api/v2/firewall/apply` (subsystem `natconf`).
- **Firewall Schedules** are `name`-keyed. Each schedule embeds exactly
  **one** time range (`RESTAPI/Models/FirewallScheduleTimeRange.inc`) —
  either recurring weekdays (`position`, 1-7) OR paired `month`+`day` date
  values, never both. Multiple time ranges per schedule (e.g. different
  hours on different days) is **out of scope** for v0.3.0 — flagged, not
  faked. The `hour` field's minute set is verified as the unusual
  `00/15/30/45/59` (not every 15 minutes), and its day-in-month table
  hardcodes February to 29 days regardless of leap year — replicated
  faithfully from the package's own validator, not "fixed."
- **Gateways** are `name`-keyed (immutable, like aliases) and scoped to the
  core identity/monitoring fields — the ~14 advanced dpinger tuning knobs
  (latency/loss thresholds, probe intervals, etc., verified in
  `RoutingGateway.inc`) are dropped for v0.3.0 since every one already has a
  safe server-side default. **Static Routes** have no name field — tracked
  by canvas-item id. Both share **`/api/v2/routing/apply`** — a THIRD
  distinct apply endpoint from `/api/v2/firewall/apply` and
  `/api/v2/firewall/virtual_ip/apply`.
- **DNS Resolver Host Overrides** key on the COMPOSITE `host`+`domain` pair
  (verified `unique_together_fields`) — this app cannot use either field
  alone as identity. The Model's nested `aliases` sub-list (additional
  alias hostnames per override) is dropped for v0.3.0; every override this
  app writes has zero aliases. **DNS Resolver Domain Overrides** key on
  `domain`. Both share a **FOURTH** distinct apply endpoint,
  `/api/v2/services/dns_resolver/apply`.
- **Local Users** and **Local User Groups** are `name`-keyed, but unlike
  every other config type here, both Models are `always_apply: true` —
  every write takes effect immediately server-side
  (`local_user_set`/`local_group_set`), so there is **no** apply-endpoint
  call at all for these two types. `password` (Users) is treated write-only
  in this app's own behavior — never diffed by drift or restored by
  rollback, even though the Model itself doesn't mark the field
  `write_only`. System-scoped accounts/groups (pfSense's own built-ins,
  e.g. `admin`) are never created, updated, or deleted by this app,
  matching what the package itself forbids.

## Coverage (v0.3.0)

Audited against the official `pfrest/pfSense-pkg-RESTAPI` v2 PHP model and
endpoint source (not prose docs). pfSense CE itself still ships no REST API;
the package remains a hard prerequisite for every config type below.

### Managed declarative resources

| Type | REST API package surface | Apply endpoint |
| --- | --- | --- |
| Firewall aliases | `/firewall/alias(es)` | `/firewall/apply` |
| Firewall rules | `/firewall/rule(s)` | `/firewall/apply` |
| NAT port forwards | `/firewall/nat/port_forward(s)` | `/firewall/apply` |
| Virtual IPs | `/firewall/virtual_ip(s)` | `/firewall/virtual_ip/apply` (own) |
| Outbound NAT mode | `/firewall/nat/outbound/mode` | `/firewall/apply` |
| Outbound NAT mappings | `/firewall/nat/outbound/mapping(s)` | `/firewall/apply` |
| 1:1 NAT mappings | `/firewall/nat/one_to_one/mapping(s)` | `/firewall/apply` |
| Firewall schedules | `/firewall/schedule(s)` | `/firewall/apply` |
| Gateways | `/routing/gateway(s)` | `/routing/apply` (own) |
| Static routes | `/routing/static_route(s)` | `/routing/apply` (own) |
| DNS Resolver host overrides | `/services/dns_resolver/host_override(s)` | `/services/dns_resolver/apply` (own) |
| DNS Resolver domain overrides | `/services/dns_resolver/domain_override(s)` | `/services/dns_resolver/apply` (own) |
| Local users | `/user(s)` | none — `always_apply` server-side |
| Local user groups | `/user/group(s)` | none — `always_apply` server-side |

Every config type exposes typed, per-field canvas forms (selects, checkboxes,
tag lists, validated text) — never a raw JSON blob — with dedicated
`validate`/`deploy`/`rollback`/`driftDetect`/`healthCheck`/`getStatus`
handlers and a `node:test` suite, matching Firewall Aliases' v0.1.0
foundation. Name-keyed and composite-keyed resources reconcile by their
natural vendor identity; resources with no vendor-unique field use the
canvas-item-id tracking pattern described above. Passwords, IPsec PSKs and
the CARP VHID password are write-only in this app's own behavior — never
drift-compared or written into rollback data, even on Models that don't
declare the field `write_only` themselves.

### Explicit exclusions (and why)

- **Certificates and Certificate Authorities** (`SystemCertificateEndpoint`,
  `SystemCertificateAuthorityEndpoint`) — importing one requires
  transmitting the **private key** (`prv`, required, `sensitive: true`)
  through canvas config, the same real-secret-material concern as VPN
  tunnels. `CertificateGenerate` avoids transmitting a key (pfSense
  generates it server-side) but is POST-only with no meaningful
  update/drift/rollback semantics (you don't "update" a generated X.509
  cert — you regenerate an entirely new one), so it doesn't fit this app's
  reconciliation model either way.
- **VPN configuration** (IPsec Phase 1/2, OpenVPN client/server, WireGuard
  tunnels/peers) — all involve real key material (pre-shared keys, private
  keys, certificates) and/or multi-resource activation sequences better
  suited to a dedicated, security-reviewed VPN-specific tool than a generic
  config-as-code canvas field.
- **Network interfaces, VLANs, bridges, LAGGs, interface groups** — these
  bind to the box's actual physical/virtual NICs; misconfiguring one can
  sever the very connection this app uses to reach the box. Host-specific
  hardware topology, not portable declarative config.
- **DHCP server/relay, BIND, HAProxy, FreeRADIUS, ACME, NTP, cron, SSH,
  service watchdogs** — several of these are themselves OPTIONAL packages
  layered on top of the REST API package (which is already a real
  prerequisite this app flags prominently); adding a second and third
  "you must also install X" chain was judged out of scope for this app's
  wave of work, not a technical impossibility.
- **System actions and diagnostics** (reboot, halt, package install/update,
  firmware update, ARP table, ping, config-history revisions, wake-on-LAN,
  the command prompt endpoint) — one-shot imperative actions or read-only
  diagnostics, not declarative, reconcilable, rollback-able resources.
- **Status/logs/state surfaces** (`Status*Endpoint`, `StatusLogs*Endpoint`,
  firewall states, CARP status, gateway status) — GET-only by design; there
  is nothing to declare or deploy.
- **REST API package's own administration** (API keys, JWT settings, the
  package's access list, GraphQL, its own settings sync) — bootstrapping
  concerns for the credential this app already consumes, not target-system
  configuration to manage as code.

Primary authorities: [pfSense REST API package](https://github.com/pfrest/pfSense-pkg-RESTAPI)
and [pfrest documentation](https://pfrest.org/).
