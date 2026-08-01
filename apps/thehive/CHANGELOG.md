# Changelog

All notable changes to the TheHive app are documented here.

## 0.2.0 — 2026-08-01

Three new organisation-configuration types, all over the TheHive REST API with
the same validate / deploy / rollback / health-check / drift-detect / status
pipeline and the shared `lib/thehiveApi.ts` v4/v5 seam.

- **Custom Fields** config type — add / edit / delete TheHive custom fields
  (name, display name, group, description, data type, mandatory flag, and
  enumeration options) over `/api/v1/customField` (create `POST`, update
  `PATCH`, delete `DELETE`, list `GET`). Upsert by field **name**; rollback
  restores the prior body or deletes a created field.
- **Observable Types** config type — add TheHive observable (datatype) types
  (name, file-attachment flag) over `/api/v1/observable/type`. TheHive 5 exposes
  no update endpoint, so this is a **create-if-missing** upsert: existing types
  are left untouched (an `isAttachment` mismatch is surfaced by drift, not
  corrected) and rollback deletes only the types the deploy created.
- **Users** config type — add / edit / delete TheHive users (login identity,
  display name, email, profile/role, organisation) over `/api/v1/user` (create
  `POST`, update `PATCH`, delete `DELETE /{id}/force`, list via the query API).
  Upsert by **login**; rollback restores the prior name/profile/org or deletes a
  created user. Passwords and API keys are intentionally **not** managed here.

> **Verify against a live TheHive (v4 vs v5).** New endpoint paths and input
> shapes are derived from the official TheHive 5 API and the maintained
> `thehive4py` client. Two nuances are flagged in the code: TheHive 5 custom
> fields have **no `enumeration` type** (use a base type + `options`, and the
> client's type list includes `url`); and observable types have **no update
> endpoint**. TheHive 4 paths for all three are the flagged single-seam
> alternate in `lib/thehiveApi.ts`.

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
