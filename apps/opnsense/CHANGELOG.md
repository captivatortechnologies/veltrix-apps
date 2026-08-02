# Changelog

All notable changes to the OPNsense app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
