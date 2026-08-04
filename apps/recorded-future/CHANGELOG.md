# Changelog

All notable changes to the Recorded Future app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added

- **Fusion Files** configuration type (`config-types/fusion-files`) with the full
  handler set — validate, deploy, rollback, healthCheck, driftDetect, getStatus —
  plus a canvas covering a file's **path** (identity) under the customer-writable
  `/home/...` namespace, its **content** (complete text — CSV / JSON / plain text)
  and an audit **comment**. This is a THIRD genuinely-writable surface, and it is
  on the **same host and credential** as Watch Lists and Entity Tags
  (`https://api.recordedfuture.com`, `X-RFToken`) — no new component or
  connection is required:
  - Deploy reads the file's current bytes (`GET /fusion/v3/files/{path}`) to learn
    whether it already exists and, for rollback, its exact prior content, then
    **uploads** the declared content (`POST /fusion/v3/files/{path}`, raw bytes —
    creates or overwrites). A file whose live content already equals the declared
    content is skipped (no write).
  - Rollback **deletes** a file this deploy created, or restores a file it
    overwrote to its **exact** prior content — a clean, leftover-free undo, same
    shape as the Entity Tags rollback.
  - Drift is read-only (`HEAD /fusion/v3/files/{path}`) and compares Fusion's own
    ETag (a SHA-256 of the live bytes) against a **locally computed** SHA-256 of
    the declared content — the file's bytes are never fetched back for drift.
  - Enforced: only `/home/...` paths are accepted (`/public/...` is Recorded
    Future-managed and documented **read-only** — "public Recorded Future-managed
    files cannot be deleted"); no `..` path segments; content is capped at 200,000
    characters (this type manages **text** feed files, not arbitrary binaries).
  - The `lib/recordedFutureApi.ts` client gained a `raw()` method — the Fusion
    Files API's contract is raw bytes with header-borne metadata (ETag /
    Last-Modified), not the List API's JSON envelope; `raw()` is a generic,
    reusable extension of the existing client (same host/token/timeout), not a
    one-off.
  - **Confirmed** endpoints: `docs.recordedfuture.com/reference/fusion-files-upload`,
    `fusion-files-get`, `fusion-files-stat`, `fusion-files-delete`,
    `fusion-files-list-directory`.
  - **VERIFY**-flagged: whether the `/home/{org}/...` org segment must be a
    literal Recorded Future org id, or is auto-resolved — undocumented; this app
    takes the operator's full path as given rather than guessing an id.

### Notes — full API re-verification (research-first, no padding)

Re-audited the **complete** Recorded Future API surface against the current
`docs.recordedfuture.com` reference (fetched live, not from memory) — every
section of the API index, not just the List API — looking specifically for any
other genuinely-declarative write path. Findings:

- **List `textEntries`** (`GET /list/{listId}/textEntries`) — confirmed
  **read-only**; there is no corresponding write endpoint. Not a candidate.
- **Cases** (`cases-create`, `-update`, `-delete`, `-search`, …) — genuine CRUD,
  and on the **same host + X-RFToken** as everything else in this app
  (`https://api.recordedfuture.com/case`). Investigated closely because of that
  auth-model match. **Excluded**: `Cases: Create` **requires** an existing
  `alert_rule` + `alert_notification` context (`reference_alert` or
  `signal_alert`) — a Case is built **from** an alert, and its lifecycle
  (`status: New → InProgress → Resolved → Dismissed`, assignee, priority) is an
  analyst **triage workflow**, not idempotent desired-state configuration. Forcing
  it through deploy/drift/rollback would fight the triage process itself (drift
  would flag an analyst's own status change as "unauthorized change"). Same
  category as Playbook Alerts / classic alert triage (see 0.2.0 notes).
- **Custom Sources** (`sources-create`, `sources-update`) — re-verified: still a
  **thin container** (`{ name, description }` only; a UUID `id`, timestamps — no
  substantive content of its own). The actual intelligence is published *through*
  a source via a separate reports-publish endpoint, which is content publishing,
  not reconcilable state. Re-confirms the 0.2.0 finding; **not shipped**.
- **ASI (Attack Surface Intelligence) Tagging / Assets / Rules** — genuinely
  writable (`ASI Assets: Apply/Remove/Bulk Tag`, `ASI Rules: Add Static Assets` —
  the latter a real declarative include/exclude scope list) — **but** a closer
  look shows these live on a **completely different product's API**:
  `https://api.securitytrails.com/v2`, authenticated with an `apikey` header (NOT
  `X-RFToken`). ASI is built on the SecurityTrails platform Recorded Future
  acquired, not the `api.recordedfuture.com` surface this app targets. Shipping
  it would mean a second vendor host, a second credential shape, and — per the
  platform's own per-product-app convention (e.g. `cisco-meraki` vs `cisco-ise`
  as separate apps for one vendor) — arguably a **separate app**, not a config
  type bolted onto this one. **Deliberately excluded** from this app.
- **Sandbox YARA rules** — re-verified the full CRUD (`sandbox-list/-create/-get/
  -update/-delete-yara-rule`): still a clean, single, fixed host
  (`https://sandbox.recordedfuture.com/api/v0`) with simple identity-by-filename
  CRUD — genuinely the closest-fitting candidate outside the current surface.
  **Still deferred**, now for a more precise reason than "different host": its
  auth is a distinct **Bearer** token, and this app's Connections page uses the
  platform's shared `<ConnectionsManager>`, which auto-registers a deploy-target
  Component from **one** `componentType` per instance and has **no input field**
  for a second secret. Onboarding a second, Bearer-authed surface cleanly needs
  either an SDK change to `<ConnectionsManager>` or a bespoke non-standard
  Connections UI — both out of place for this pass. (`rapid7` is the one
  existing two-product precedent in this codebase — InsightVM Basic-auth +
  InsightIDR `X-Api-Key` — and it sidesteps the problem by dropping automatic
  component registration entirely, leaving BOTH of its component types to manual
  Inventory setup. Adopting that here would regress the existing
  `recorded-future-cloud` auto-register experience just to add YARA rule
  management, which is not a good trade.) Remains a strong **future** candidate
  once the credential/connection UX for a second auth model is budgeted properly.
- **Alerting rules, Detection Rules, Playbook Alerts** — re-confirmed **READ /
  triage-only**, no change from 0.2.0 (`alerts-search-rules` has no create/update
  sibling; `detection-rules-search` is search-only; playbook alert updates are
  instance triage). **Not shipped.**
- **Analyst Notes** — re-confirmed **content publishing** (draft → preview →
  publish → delete is a document lifecycle, not reconcilable configuration
  state). **Not shipped.**

**Bottom line:** of the surfaces re-audited, exactly **one** new addition —
Fusion Files — fit both tests this app applies: genuinely declarative
(create/read/update/delete a named, complete-content resource) **and** reachable
on the same host + credential this app already manages. ASI and Sandbox are
real writable surfaces on genuinely different products/hosts/auth models and are
honestly out of scope here; Cases and Custom Sources are writable but a poor
config-as-code fit. Recorded Future remains, deliberately, a **read-centric**
API — see the README's Coverage section for the full breakdown.

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
