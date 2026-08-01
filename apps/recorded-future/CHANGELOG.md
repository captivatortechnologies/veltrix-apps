# Changelog

All notable changes to the Recorded Future app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-01

### Added

- **Watch List Entity Tags** configuration type (`config-types/entity-tags`) with
  the full handler set — validate, deploy, rollback, healthCheck, driftDetect,
  getStatus — plus a canvas covering the **list name**, the **entity** (RF entity
  id or company name, with a `matchBy` mode), the entity's **tags** (the complete
  set) and an audit **comment**. This is a second genuinely-writable surface on the
  **same** List API (same `X-RFToken` auth, same `recorded-future-cloud` component)
  as Watch Lists:
  - Deploy resolves the company-type list (`POST /list/search { type: company }`),
    reads the entity's current tags (`GET /list/{id}/entitiesWithTags`) and
    **replaces** the full tag set (`POST /list/{id}/entity/tags { entity, tags }`).
  - "Replace Entity Tags" is **authoritative** (it sets the entity's COMPLETE tag
    set), so — unlike the additive Watch Lists type — this is a true upsert of the
    whole set, drift is exact set-equality (a declared tag missing **or** an
    undeclared tag present is drift), and **rollback restores the prior tag set
    exactly** (a clean, leftover-free undo — no list is created or deleted).
  - Documented constraints enforced: tags apply **only to company-type lists**, at
    most **9 tags** per entity (hard error), and the **fixed tag vocabulary** (57
    known API names — advisory warning on an unrecognised but well-formed tag,
    since the API is the final authority).
  - **Confirmed** endpoints: `docs.recordedfuture.com/reference/lists-replace-entity-tags`,
    `lists-entities-with-tags`, `lists-available-tags`.

### Notes — how much of Recorded Future is actually writable (be honest)

Researched the official API index (`docs.recordedfuture.com/llms.txt`) for writable
configuration surfaces **beyond** the List API. Findings, verbatim about what is
and isn't a real config-as-code write path:

- **Alerting rules — READ-ONLY (flagged).** Recorded Future exposes **no**
  create/update endpoint for *alert rule definitions*. The only alert write is
  `POST /alerts/update` — **triage** of existing alert instances (status / assignee
  / notes), not authored configuration. **Not shipped.**
- **Playbook Alerts — instance/triage only (flagged).** `POST /playbook-alerts/{id}/update`
  updates an existing alert instance, and `.../malicious-sites/create` files a new
  alert. These are operational actions on alert *instances*, not reconcilable
  declarative config. **Not shipped.**
- **Sandbox YARA rules — genuinely writable, but a different product (deferred).**
  Full CRUD exists (`/yara` create/update/delete) and is a strong config-as-code
  fit, BUT it lives on a **separate host and auth** —
  `https://sandbox.recordedfuture.com/api/v0` with a **`Bearer`** token (a distinct
  Sandbox access key), not `api.recordedfuture.com` + `X-RFToken`. Adding it would
  need a second credential/connection surface, so it is deliberately **not** part of
  this minor bump; it is a strong future candidate (would rollback cleanly via its
  real delete endpoint). Same reasoning applies to Sandbox analysis profiles.
- **Analyst Notes / Custom Sources — writable but poor config fit (skipped).**
  Analyst-note draft/publish/delete is **content publishing** (not reconcilable
  state); custom-source create/update is a thin name/description container. Neither
  maps cleanly onto deploy/drift/rollback.
- **Detection Rules — READ-ONLY (flagged).** `POST /detection-rules/search` only —
  Insikt Group rules are consumed, not authored.

**Bottom line:** of the surfaces researched, exactly **one** additional
config-as-code write path fit the app's existing List-API auth/host model — entity
tags — so v0.2.0 ships that. Recorded Future remains a **read-centric** API.

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
