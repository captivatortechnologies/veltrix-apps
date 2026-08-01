# Changelog

All notable changes to the Vectra AI app are documented here.

## 0.2.0 — 2026-08-01

Two new configuration types over the Vectra Detect REST API (v2.5, 443).

- **Groups** config type — create / edit / delete Vectra groups (named sets of
  hosts, IPs, domains or accounts used to scope detection tuning), over
  `/api/v2.5/groups`, with validate / deploy (upsert by group name) / rollback
  (restore prior or delete created) / health-check / drift-detect / status.
  Only static membership is managed; a group's `type` is set at create time.
- **Proxies** config type — create / edit / delete Vectra proxy IPs (internal
  addresses Vectra treats as proxies so detections are attributed to the real
  client behind them), over `/api/v2.5/proxies`, with the same pipeline lifecycle
  (upsert by proxy address).
- Registered `groups` and `proxies` app permissions; both surface as Overview
  cards via the `/meta` route (no new sidebar navigation).

> Endpoint shapes follow Vectra's official `vectra_api_tools` v2 (Detect) client
> and should be verified against a live Vectra brain. FLAGGED for verification:
> the official v2 API validates group `type` as host / domain / ip — the `account`
> option is offered but unverified; dynamic regex group membership (`rules`) has no
> documented v2 object shape and is out of scope (static members only); a group's
> `type` is immutable on update (v2 PATCH carries name/description/members); and the
> proxies list-envelope shape (`proxies` vs DRF `results`, flattened vs nested) is
> read defensively. Considered but dropped: `users` (v2 exposes PATCH/update only —
> no create, so not cleanly upsertable) and `threatFeeds` (create + delete only, no
> PATCH — no clean in-place update/rollback).

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Triage Rules** config type — create / edit / delete Vectra triage rules
  (description, detection category + type, whitelist or triage category, and
  host/network scope) over the Vectra Detect REST API (v2.5, 443), with
  validate / deploy (upsert by rule description) / rollback (restore prior or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the Vectra Detect REST API
  (`GET /api/v2.5/rules?page_size=1`, HTTPS, self-signed tolerated) using a
  Vectra API token (`Authorization: Token <token>`).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API
  token → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Vectra brain; saving a connection registers
  `vectra-brain` as a deploy target).

> Vectra Detect API paths follow the v2.5 REST API and should be verified against
> a live Vectra brain. The exact `detection_category` enum values/casing and valid
> `detection` (detection type) names are Vectra-defined — only `LATERAL MOVEMENT`
> is confirmed from Vectra's official API docs. The newer Vectra platform v3
> (RUX / Respond) uses OAuth2 client-credentials (Bearer) and is noted for a future
> version. TLS verification is off by default (self-signed on-prem brains) and
> configurable via the `verify_tls` setting.
