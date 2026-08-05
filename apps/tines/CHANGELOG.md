# Changelog — Tines

All notable changes to the Tines Veltrix app are documented here.

## 0.1.0 — 2026-08-05

Foundation release. Research-first against the official Tines API reference
(`https://www.tines.com/api/...`, fetched 2026-08-05).

- New Veltrix app **Tines** (category **SOAR**) — manage Tines
  security-automation configuration as code through the Tines REST API
  (`https://<tenant-domain>/api/v1`), Bearer API-key auth.
- **Teams** configuration type (`teams`, `/api/v1/teams`): name, reconciled
  by name.
- **Folders** configuration type (`folders`, `/api/v1/folders`): name, team,
  content type (`STORY`/`CREDENTIAL`/`RESOURCE`) and an optional parent
  folder (resolved by name), reconciled by (team, content type, parent,
  name). Two-pass deploy resolves a parent declared earlier in the same
  canvas.
- **Tags** configuration type (`tags`, `/api/v1/tags`): name, team and color
  (named palette or custom hex), reconciled by (team, name).
- **Global Resources** configuration type (`global-resources`,
  `/api/v1/global_resources`): name, team, text/JSON value, sharing
  (read_access/shared_team_slugs), description and an optional folder,
  reconciled by (team, name). File-type resources are out of scope (see
  README Coverage).
- **Credentials** configuration type (`credentials`,
  `/api/v1/user_credentials`): METADATA ONLY — name, mode (`TEXT`/`AWS`/
  `JWT`/`OAUTH`/`MTLS`), non-secret metadata, allowed hosts, expiry and
  sharing. Secret material (`secret_value`/`secret_config`) is write-only —
  sent when supplied, never read back, diffed, or restored on rollback.
  `HTTP_REQUEST_AGENT`/`MULTI_REQUEST` modes are out of scope (nested/array
  shapes, not flat secret material — see README Coverage).
- **Story Settings** configuration type (`story-settings`, `GET
  /api/v1/stories` + `PUT /api/v1/stories/{id}`): settings of an EXISTING
  Story — enabled state, priority, change control, monitor failures,
  description, event retention (days, converted to seconds) and tags
  (add/remove diffed against the story's live tags). NEVER creates,
  deletes, or edits the Story graph itself — deploy fails with an
  actionable message when the named story doesn't exist. `team_id` is a
  search-only disambiguation filter, never sent in the update body, so this
  app never moves a story between teams. Send-to-Story/Webhook API
  entry/exit action-node references are out of scope (graph-internal — see
  README Coverage).
- **Team Members** configuration type (`team-members`,
  `/api/v1/teams/{team_id}/invite_member` + `/remove_member`): RBAC
  membership by (team, email) + optional role. Additive only — a member
  absent from the canvas is never removed; a live role that no longer
  matches the declared one is reported as drift, never auto-corrected
  (Tines has no update-role endpoint).
- REST API client (`lib/tinesApi.ts`): per-tenant base URL
  (`https://<tenant-domain>/api/v1`), Bearer API-key auth, page-based
  pagination (`?page=&per_page=`, following `meta.pages`), and 429
  Retry-After handling.
- Shared live-options provider (`config-types/lib/tinesOptions.ts`) powering
  `remote-select` pickers for Team (every type that references one) and
  Story (Story Settings).
- Connection-level connectivity test (`GET /api/v1/teams`) and the standard
  Overview / Setup Guide / Connections client pages.
- No database and no BYOL — the app is a pure REST passthrough.
