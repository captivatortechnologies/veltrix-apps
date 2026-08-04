# Changelog

All notable changes to the Tanium app are documented here.

## 0.3.0 — 2026-08-04

Exhausted the Tanium REST v2 config-as-code write surface against Tanium's own
published Platform REST API reference plus its public integrations (Cortex
XSOAR `Tanium_v2`, Splunk SOAR `taniumrest`) — one new configuration type
shipped, one existing type gained a second authoring mode, and everything else
researched is documented as an honest exclusion. See README "Coverage" for the
full audit, citations, and exclusion reasons.

- **Sensors** config type — add / edit / delete Tanium sensors
  (`/api/v2/sensors`). A sensor is a name plus a primary per-platform script
  (platform + script type + script), with optional description, category,
  key/default-value parameters, a result max-age, and extra per-platform
  scripts (`additionalQueriesJson`) for a multi-platform sensor. Full pipeline:
  validate / deploy (upsert by name, delete + recreate) / rollback /
  health-check / drift-detect (primary script + max age) / status. **Flagged:**
  Tanium's public integrations and its own published Platform REST API
  reference confirm only `GET` (list, by-name) for sensors — `POST` create and
  `DELETE` follow the same generic named-entity convention already shipped for
  packages/saved-questions, but neither verb is independently exercised for
  sensors anywhere researched. Verify against a live Tanium.
- **Computer Groups** — added a **Manual** authoring mode alongside the
  existing filter-expression mode, confirmed by the same public integration
  that documents the existing type (`tn-create-manual-group`): an explicit
  `computerNames` / `ipAddresses` list, sent as `computer_specs` to
  `POST /api/v2/computer_groups` (a different create endpoint from the
  filter-based `POST /api/v2/groups`) — both modes then read / update / delete
  through the same `/api/v2/groups` collection. Drift-detect now compares
  membership (order-insensitive) for manual groups.
- **Coverage section** added to the README: every confirmed operation with its
  citation, and an itemized, cited exclusion list — action groups, saved
  actions, user groups, roles, content sets, content-set roles, filter groups,
  dashboards and Tanium Connect plugin schedules — each with the specific
  reason it does not meet this app's bar for a config-as-code type.

## 0.2.0 — 2026-08-01

Two new configuration types over the Tanium REST v2 API.

- **Saved Questions** config type — add / edit / delete Tanium saved questions
  (`/api/v2/saved_questions`). A saved question pairs a name with a question:
  supply the question text (sent inline for the server to parse) or a pre-parsed
  Question ID (the verified `{ name, question: { id } }` path). Full pipeline:
  validate / deploy (upsert by name) / rollback / health-check / drift-detect
  (question text) / status.
- **Packages** config type — add / edit / delete Tanium packages
  (`/api/v2/packages`). A package is a name plus the `command` the Tanium Client
  runs, with optional display name, command timeout and expiry. Full pipeline:
  validate / deploy (upsert by name) / rollback / health-check / drift-detect
  (command + timeout) / status.
- **Shared REST v2 seam** — `lib/taniumRestEntity.ts` centralises the common
  named-object verbs (list, by-name, by-id, create, delete) and the upsert /
  rollback engine; `lib/taniumHealth.ts` and `lib/taniumStatus.ts` share the
  health check and deployment status across config types.

> **Verify against a live Tanium.** These objects expose no confirmed in-place
> update in REST v2, so an existing one is replaced by **delete + recreate**
> (which churns the object id). Saved-question inline `question.question_text`
> parsing and the package `command_timeout_seconds` field name are REST v2
> conventions the public integrations do not exercise — see README "Verify
> against a live Tanium".

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Computer Groups** config type — add / edit / delete Tanium computer groups
  (name + a filter expression, with an optional structured-filter JSON for
  advanced specs) over the Tanium REST v2 API (443), with validate / deploy
  (upsert by name) / rollback (restore prior or delete created) / health-check /
  drift-detect / status.
- **Connectivity test** against the Tanium REST v2 API
  (`/api/v2/system_status`, HTTPS, self-signed tolerated) using a Tanium API
  token or a username + password session login.
- **Auth seam** — `lib/taniumApi.ts` isolates authentication: an API token is
  sent verbatim in the `session:` header; a username + password is exchanged for
  a session via `POST /api/v2/session/login` (read from `data.session`).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (credential → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Tanium server; saving a connection registers
  `tanium-server` as a deploy target).

> Tanium REST v2 API paths follow the documented v2 conventions and public
> Tanium integrations; several shapes should be verified against a live Tanium
> instance (see README "Verify against a live Tanium"). TLS verification is off
> by default (self-signed) and configurable via the `verify_tls` setting.
