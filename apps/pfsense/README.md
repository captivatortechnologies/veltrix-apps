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

| Type | Surface | Status |
|---|---|---|
| **Firewall Aliases** | `/api/v2/firewall/alias(es)` + `/api/v2/firewall/apply` | ✅ v0.1.0 |

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

## Notes

- **Port ranges use a colon, not a hyphen** (`8000:8100`, per pfSense's own
  `is_portrange()`) — a common mistake when porting rules from other
  firewalls.
- Client-side `address` validation for `host`/`network` types optimistically
  accepts any alias-name-shaped token as a possible **nested alias**
  reference (and, for `port`, as a possible service name pfSense could
  resolve via `getservbyname()`) — this app cannot verify a live nested
  alias or `/etc/services` entry exists from a schema-only validate step;
  the REST API package is authoritative and will reject an unresolvable
  reference at deploy time.
- TLS verification is off by default (self-signed) and configurable via the
  `verify_tls` setting.

Apache-2.0.
