# Changelog

All notable changes to the Vectra AI app are documented here.

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
