# Changelog

All notable changes to the Recorded Future app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-01

### Added

- **Initial foundation** for managing Recorded Future configuration as code over
  the Recorded Future **List API**. Config-as-code only — no database, no
  infrastructure provisioning.
- **Recorded Future REST client** (`lib/recordedFutureApi.ts`): calls the fixed
  cloud API (`https://api.recordedfuture.com`, overridable for regional clouds),
  authenticating every request with the **`X-RFToken`** header (token sent
  verbatim — no `Bearer`). Includes a List-API connectivity/health probe
  (`POST /list/search { limit: 1 }`) and typed GET/POST/DELETE helpers.
- **Watch Lists** configuration type (`config-types/watch-lists`) with the full
  handler set — validate, deploy, rollback, healthCheck, driftDetect, getStatus —
  plus a canvas covering the list **name** (identity), **type**
  (`ip`/`domain`/`hash`/`vulnerability`/`entity`/`company`/`attacker`/`executive`/`source`/`text`),
  member **entities** (one per line) and an audit **comment**. Deploy reconciles by
  list name: it reuses an existing list (`POST /list/search`) or creates one
  (`POST /list/create`), reads current members (`GET /list/{id}/entities`) and
  **adds** each declared entity (`POST /list/{id}/entity/add`). Rollback removes the
  entities it added (`DELETE /list/{id}/entity/remove`).
- **Connections** page (`recorded-future-cloud` component) + a `testConnection`
  handler that probes `POST /list/search`, and **Overview** + **Setup Guide** pages.

### Notes — Recorded Future's API is largely READ (be honest)

- Recorded Future is a threat-**intelligence** platform; its API is overwhelmingly
  **read** (entity enrichment / lookup, risk lists, alerts, threat maps, detection
  rules). The **List API** (Watch Lists) is its **one genuinely writable
  configuration surface**, so this foundation ships exactly that — the `watch-lists`
  type — rather than dressing read-only enrichment up as configuration. This mirrors
  the honest-scoping precedent of the Cortex XDR and Semgrep apps.
- The List API has a **confirmed** write path: `POST /list/create`,
  `POST /list/{id}/entity/add`, `DELETE /list/{id}/entity/remove`
  (docs.recordedfuture.com/reference/lists-create and siblings).
- **No delete-list endpoint** is documented — rollback empties a newly-created list
  (removing the entities it added) and reports the leftover empty list for **manual**
  removal; it cannot delete the list itself. Deploy is **additive** (does not prune
  undeclared members).
- The exact **entity-resolution** semantics (`{ type, name }` auto-resolution for
  IP / Domain / Hash / Vulnerability vs. an RF entity `id` for other types) and the
  `/list/{id}/entities` member shape are marked `VERIFY against live Recorded Future`
  in the code — confirm against a live account before production use.
