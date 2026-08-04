# Changelog

All notable changes to the JumpCloud app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

Config-as-code surface exhaustion. Nine new configuration types, each a full pipeline
surface (validate / deploy / rollback / health check / drift detect / status), researched
against JumpCloud's own published OpenAPI 3.1 specs (v1 `docs/api/1.0/index.yaml` and v2
`docs/api/2.0/index.yaml` from `github.com/TheJumpCloud/jumpcloud-docs-public` — the source
of `docs.jumpcloud.com`), superseding the earlier `jcapi-python`-derived research for this
release. Config types are now grouped in the sidebar: **Directory**, **Policies**,
**Access Control**, **Automation**, **Organization**.

- **LDAP Server Settings** (Directory) — update settings (name, lockout action,
  password-expiration action) on an **existing** JumpCloud LDAP-as-a-Service server over
  `GET /api/v2/ldapservers` + `PATCH /api/v2/ldapservers/{id}`. There is no create/delete
  endpoint for LDAP servers in the API — this type can only manage one already provisioned
  in the Admin Console.
- **Policy Groups** (Policies) — create / edit / delete JumpCloud Policy Groups over
  `GET/POST /api/v2/policygroups` and `GET/PUT/DELETE /api/v2/policygroups/{id}` (the
  `PolicyGroupData` write model accepts only `name`), plus exclusive member-Policy
  management via `GET/POST /api/v2/policygroups/{id}/members`.
- **IP Lists** (Access Control) — create / edit / delete named IP/CIDR collections over
  `GET/POST /api/v2/iplists` and `GET/PUT/DELETE /api/v2/iplists/{id}`. Referenced from
  Conditional Access Policies (`conditions.ipAddressIn`) and RADIUS network-source rules.
- **RADIUS Servers** (Access Control) — create / edit / delete over the JumpCloud API v1
  (`GET/POST /api/radiusservers`, `GET/PUT/DELETE /api/radiusservers/{id}`; the v2 RADIUS
  Servers API exposes only association endpoints, no server CRUD). Manages network source,
  shared secret, MFA, and certificate/RadSec settings. The Shared Secret is a
  password-typed field; unlike other secret-bearing types in this app, JumpCloud's own API
  returns `sharedSecret` on GET, so rollback restores the exact prior secret.
- **Conditional Access Policies** (Access Control) — create / edit / delete JumpCloud
  Authentication Policies over `GET/POST /api/v2/authn/policies` and
  `GET/PATCH/DELETE /api/v2/authn/policies/{id}` — allow/deny + MFA obligations for the
  User Portal, an SSO Application, LDAP or the Admin Portal, gated by conditions
  (`deviceEncrypted`, `deviceManaged`, `ipAddressIn`, `locationIn`, `not`/`all`/`any`).
  `targets` / `conditions` are authored as raw JSON (same pattern as the `Policies` type's
  `values` field), documented in the canvas with JumpCloud's own condition grammar.
- **Commands** (Automation) — create / edit / delete saved scripts over the JumpCloud API
  v1 (`GET/POST /api/commands`, `GET/PUT/DELETE /api/commands/{id}`): command text, OS,
  run-as user, sudo, shell, launch type, schedule and command-runner users. Binding a
  command to systems/system-groups is out of scope (JumpCloud's own API docs mark the v1
  object's `systems` field "Not used" for that — use `/api/v2/commands/{id}/associations`).
- **Custom Email Configuration** (Organization) — create / edit / delete transactional
  email overrides over `POST /api/v2/customemails` and
  `GET/PUT/DELETE /api/v2/customemails/{custom_email_type}` (8-value type enum).
- **Password Manager Policies** (Organization) — a tenant singleton managing vault export
  control over `GET /api/v2/passwordmanager/company/policies` and
  `PUT .../company/policies/{id}?disableExport=<bool>` (a query parameter, not a JSON
  body — `disableExport` is confirmed to be the entire writable surface).
- **Software Apps (Catalog)** (Organization) — create / edit / delete catalog-referenced
  managed software over `GET/POST /api/v2/softwareapps` and
  `GET/PUT/DELETE /api/v2/softwareapps/{id}` (auto-update, update-delay, install/uninstall
  state, App Catalog reference). Custom/private package uploads (binary artifacts,
  checksums, detection rules) are intentionally excluded — not declarative JSON config.

> **Dropped surface (researched and rejected, with reasons):**
> - **Directories** — `GET /api/v2/directories` is read-only (enumeration only); creating
>   an Active Directory / GSuite / Office 365 connector requires an interactive OAuth
>   consent or an on-premises AD agent install (a bootstrap, not JSON config) — same
>   reasoning as the SSO Applications drop below.
> - **MDM (Apple / Google / Microsoft)** — Apple MDM setup is a certificate-signing
>   exchange with Apple (POST returns a plist to sign, PUT uploads the signed cert back —
>   an inherently interactive bootstrap); Google EMM / Microsoft MDM similarly require an
>   enterprise-binding handshake. Device-scale enrollment / configuration-profile fan-out
>   is outside this app's single `jumpcloud-org` connection model.
> - **Global feature settings** (`/api/v2/feature-settings`) — a generic key/value store
>   with an opaque, untyped `value` per setting and no fixed schema across the whole
>   catalog of org features — too risky to author blind without per-setting documentation.
> - **SSO Applications** — already dropped in v0.2.0 (association-only, no create); carried
>   forward.
> - Per-user/device data, runtime/action endpoints (queued command execution, MDM command
>   queues, built-in system power commands) and read-only monitoring (System Insights,
>   reports, identity risk, Directory Insights) remain out of scope, per this app's existing
>   conventions.
>
> See the README's **Coverage** section for the complete managed/excluded surface.

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
