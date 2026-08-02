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
