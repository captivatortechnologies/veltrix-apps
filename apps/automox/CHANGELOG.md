# Changelog

All notable changes to the Automox app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Policies** config type — create / edit / delete Automox Policies over the Automox Console API
  (`GET/POST /policies`, `GET/PUT/DELETE /policies/{id}`), org-scoped via the `o` query parameter, with
  validate / deploy (upsert by name, rename-safe id tracking) / rollback (restore prior or delete
  created) / health-check / drift-detect / status.
  - **Patch** policies are modeled in full: schedule (day-of-week picker converted to Automox's
    `schedule_days`/`schedule_weeks_of_month`/`schedule_months` bitmasks, with the "every week / every
    month" defaults auto-filled when left blank), patch rule (All / Filter / Manual / Advanced), filter
    type (Include / Exclude / Patch by Severity), notification toggles, and optional JSON device
    targeting filters.
  - Two live-API behaviors verified via the community `automox-mcp` server (not in the published
    OpenAPI spec) are applied automatically: `configuration.filter_type` is forced on every Patch
    policy regardless of `patch_rule` (issue #206), and `configuration.device_filters_enabled` is set
    whenever `device_filters` are supplied (otherwise silently ignored by the API).
  - `POST /policies` returns `201` with an **empty body** (verified) — the created policy's id is
    resolved by listing the org's policies and matching the just-created name (highest id wins, since
    the list is name-ordered, not recency-ordered).
- **Connectivity test** against `GET /orgs` (the one endpoint used here that needs no Organization ID)
  using a Bearer API key, cross-checking the configured Organization ID against the orgs the key can see.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key + Org ID → credential →
  author), and Connections (wraps the SDK `ConnectionsManager` against the fixed Automox endpoint;
  saving a connection registers `automox-org` as a deploy target).

> **Dropped surface (v0.1.0) — Required Software and Custom (Worklet) policy schemas.** Per the task's
> guidance to start with the common Patch policy shape, **Required Software** and **Custom (Worklet)**
> policies are accepted with a raw `configuration` JSON object rather than a fully modeled canvas —
> their configuration shapes (installer scripts / Worklet code) are materially different from Patch and
> were out of scope for this release. See README.md for the example Required Software fields.
>
> **Verify against a live Automox tenant (FLAGGED):**
> - The exact `configuration` shape for Required Software / Custom policies beyond the documented
>   example fields.
> - `PUT /policies/{id}`'s response body/status (the OpenAPI excerpt used did not fully document it).
> - `schedule_weeks_of_month` / `schedule_months` bit order beyond the "all weeks" (62) / "all months"
>   (8190) constants used for auto-fill.
