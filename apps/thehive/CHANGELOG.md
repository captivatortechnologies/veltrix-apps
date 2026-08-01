# Changelog

All notable changes to the TheHive app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Case Templates** config type — add / edit / delete TheHive case templates
  (name, display name, title prefix, severity, TLP, PAP, tags, description, and
  prefilled tasks) over the TheHive REST API, with validate / deploy (upsert by
  template name) / rollback (restore prior or delete created) / health-check /
  drift-detect / status.
- **Connectivity test** against the TheHive REST API (`GET /api/v1/user/current`,
  Bearer API key, self-signed tolerated).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  TheHive instance; saving a connection registers `thehive` as a deploy target).

> **TheHive 4 vs 5 caveat.** The primary target is **TheHive 5** (StrangeBee,
> `/api/v1/caseTemplate`, listed via `POST /api/v1/query`). **TheHive 4**
> (`/api/case/template` + `/_search`) is a flagged single-seam alternate in
> `lib/thehiveApi.ts` (`API_VERSION`). API paths and case-template field shapes
> should be **verified against a live TheHive** (note v4 vs v5). TLS verification
> is off by default (self-signed) and configurable via the `verify_tls` setting.

> **BYOL planned.** Hosting a self-managed TheHive stack (BYOL infrastructure
> provisioning + database) is planned for a later wave and is intentionally not
> part of this foundation.
