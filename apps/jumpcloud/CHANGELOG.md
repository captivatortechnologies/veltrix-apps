# Changelog

All notable changes to the JumpCloud app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-01

Three new configuration types, each a full pipeline surface (validate / deploy / rollback /
health check / drift detect / status) over the JumpCloud API v2, using the same `x-api-key`
client and rename-safe upsert pattern as User Groups.

- **System Groups** config type — create / edit / delete JumpCloud System (device) Groups
  (name, description) over `GET/POST /api/v2/systemgroups` and `PUT/DELETE /api/v2/systemgroups/{id}`.
- **Policies** config type — create / edit / delete JumpCloud Policies over
  `GET/POST /api/v2/policies` and `PUT/DELETE /api/v2/policies/{id}`. Policies are
  **template-based**: each item authors the core writable fields — `name`, the Policy Template
  Id, an `active` flag, and the template's configuration `values` as a JSON array
  (`[{ configFieldID, configFieldName, value }]`). Drift compares only the values the canvas
  declares, so unmanaged template fields never register as drift.
- **User Group Memberships** config type — manage which users belong to an existing User Group,
  declared by email / username / user id, over `GET/POST /api/v2/usergroups/{id}/members`
  (`{ op: add|remove, type: user, id }`). Members are resolved to ids via the v1
  `GET /api/systemusers` directory. Supports additive (default) or exclusive membership;
  rollback reverses exactly the add/remove operations it applied.

> **Dropped surface — SSO Applications.** The task's third candidate was SSO Applications
> (`/api/v2/applications`), but the JumpCloud v2 Applications API exposes only association
> traversal (members / user-groups), not full CRUD, and creating an SSO application requires a
> catalog template plus complex SSO configuration — there is no clean write path. Per the task's
> guidance we shipped **User Group Memberships** (a clean, writable v2 resource) in its place.
>
> **Verify against a live JumpCloud tenant (FLAGGED):**
> - System Groups: the `SystemGroupData` model markdown documents only `name`; the `description`
>   body field is sent but unverified in the public jcapi excerpt.
> - Policies: whether the write model (`PolicyRequest`) accepts `active` (only the Policy
>   *response* model documents it), and the exact `PolicyValue` wire shape beyond `configFieldID`
>   (`configFieldName` / `value` are not in the jcapi excerpt).
> - Memberships: the `GraphConnection` / `GraphObject` member shape (`to.id` is assumed), and the
>   v1 `/systemusers` list wrapper (`{ results, totalCount }`, limit/skip paging).

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **User Groups** config type — create / edit / delete JumpCloud User Groups (name, description,
  email, membership method STATIC / DYNAMIC_AUTOMATED) over the JumpCloud API v2 (`/usergroups`), with
  validate / deploy (upsert by name, rename-safe id tracking) / rollback (restore prior or delete
  created) / health-check / drift-detect / status.
- **Connectivity test** against the JumpCloud API (`GET /api/v2/usergroups`) using an `x-api-key`
  header (plus optional `x-org-id` for multi-tenant admins).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key → credential → author),
  and Connections (wraps the SDK `ConnectionsManager` against the fixed JumpCloud endpoint; saving a
  connection registers `jumpcloud-org` as a deploy target).

> The JumpCloud API endpoint is fixed (`https://console.jumpcloud.com/api`, v2 under `/api/v2`).
> The `POST`/`PUT` body fields beyond `name` (`description`, `email`, `membershipMethod`) should be
> verified against a live JumpCloud tenant.
