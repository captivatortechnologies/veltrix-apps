# Axonius

Manage **Axonius** — CAASM (Cyber Asset Attack Surface Management) — as code on the
Veltrix Security-as-Code platform. Author saved queries, enforcement sets, asset
tags, roles, internal users, data scopes, instance attributes and a lifecycle
(discovery schedule) settings overlay in the Configuration Canvas, and drive them
all through the pipeline — **validate → deploy → health check → drift detect →
rollback** — over the Axonius REST API.

## What it manages

| Configuration type | What it does |
| --- | --- |
| **Saved Queries** (`saved-queries`) | Create / update / delete Axonius saved queries for the `devices` and `users` modules — name, AQL filter and display columns. Upsert is keyed on the `(module, name)` pair. |
| **Enforcement Sets** (`enforcement-sets`) | Create / update / delete Axonius enforcement sets — a named policy with a main action from the action library plus optional triggers. Upsert is keyed on the set name. |
| **Tags** (`tags`) | Apply / remove a named label to every device or user matching an AQL filter. |
| **Roles** (`roles`) | Create / update / delete Axonius roles — a named permission set plus an optional Data Scope restriction. Upsert is keyed on the role name; built-in roles are never adopted. |
| **Users** (`users`) | Create / update / delete Axonius-internal system-user accounts and their role assignment. Upsert is keyed on `user_name`, scoped to internal accounts only. No password material is ever read or written. |
| **Data Scopes** (`data-scopes`) | Create / update / delete named asset-visibility restrictions (row-level security) built from devices/users saved-query references. Requires the Data Scopes feature (Enterprise). |
| **Instances** (`instances`) | Update the display name, hostname and environment-name flag of an EXISTING Axonius instance (cluster node) by `node_id`. Update-only — never creates, deletes or deactivates a node. |
| **Lifecycle Settings** (`lifecycle-settings`) | Tenant-wide singleton: a partial, top-level JSON overlay onto the discovery (lifecycle) schedule settings. Only the declared keys are touched. |

See [Coverage](#coverage-v030) below for what was evaluated and deliberately
excluded, and why.

## Connecting to Axonius

Axonius authenticates the REST API with a **service-account API key + secret**
(required on Axonius 6.1.74+; earlier versions allow a regular user account). Get
them from your account page (gear icon → **My Account**, or
`https://<tenant>/account`).

On the **Connections** page, add a connection:

- **Endpoint** — your Axonius tenant host, its HTTPS address on 443
  (e.g. `tenant.axonius.com`).
- **API key** — stored as the credential username.
- **API secret** — stored as the credential token.

Use **Test** to verify reachability and authentication (`GET
api/settings/meta/about`). Saving the connection also registers the tenant as a
deploy-target component (`componentType: axonius`).

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `verify_tls` | `false` | Enforce a valid TLS certificate. Off by default because on-prem Axonius often ships a self-signed cert; turn on for a cloud tenant. |
| `api_version` | `""` | Optional REST API version segment inserted after `/api/` (e.g. `V4.0` → `/api/V4.0/...`). Blank uses the unversioned `/api/` root. |

## Roles — permission sets with an optional data-scope restriction

A role is a named permission set: a nested category → action JSON object
(tenant/version-specific — see `GET api/labels` on your tenant, or an existing
role's export, for the exact category/action names) plus an optional
`data_scope_restriction` that limits which assets the role's users can see.
Upsert is keyed on the role **name**; a canvas item whose name collides with a
built-in Axonius role (Admin, Restricted, Viewer, ...) is never adopted —
predefined roles are excluded from the identity match, so Axonius's own
uniqueness check surfaces a clear create error instead of silently touching a
built-in. When "Restrict to a Data Scope" is enabled, the declared Data Scope
**name** is resolved to its uuid at deploy time against the `data-scopes`
config type's live list — deploy the data scope first, or the resolution fails
with a clear error. Deleting a role Veltrix created removes it with `DELETE
api/settings/roles/{uuid}` and **no request body** (verified
`request_as_none` on the endpoint definition).

## Users — internal accounts only, never a password

A user item manages an **Axonius-internal** system-user account (`source:
"internal"`) and its role assignment. Upsert is keyed on **`user_name`**,
scoped to internal accounts — an LDAP/SAML/SSO-provisioned account with the
same user name is never matched, adopted or modified. The declared **Role
Name** is resolved to its role id at deploy time against the live role list
(built-in roles included).

**This config type never reads or writes password material.** A created user
always requests an Axonius-generated password
(`auto_generated_password: true`) rather than a supplied one; an updated
user's password field is omitted from every request entirely, so a deploy
never touches a live user's password. Operators reset a user's password
through Axonius's own reset-link flow (`api/settings/users/tokens/...`), not
through config-as-code — the same secrets-hygiene posture this app already
takes with the API key/secret credential.

## Data Scopes — row-level asset visibility, referenced by role

A data scope is a named set of devices and/or users **saved queries** — the
saved-query results define exactly which assets a role restricted to that
scope can see. This is Axonius's row-level-security primitive and requires the
**Data Scopes feature** enabled on the tenant (an Enterprise capability); on a
tenant without it, deploy surfaces Axonius's own feature-gate error. Upsert is
keyed on the scope **name**. `Devices Saved Queries` / `Users Saved Queries`
are declared by saved-query **name** (not uuid) and resolved against the
`saved-queries` config type's live list at deploy time — a scope needs at
least one query reference of either module (Axonius itself rejects a scope
with none). Deploy the referenced saved queries first, or resolution fails
with a clear, actionable error.

## Instances — update-only attributes of an existing cluster node

An Axonius **instance** (the core/master, or a collector node) joins the
cluster through its own installer, never through this API — so this config
type is strictly **update-only**: it manages the display name (`node_name`),
`hostname` and the "use as environment name" flag of an instance that already
exists, identified by its `node_id` (from **Settings → Lifecycle →
Instances**, or `GET api/instances`). A `node_id` that doesn't match a live
instance fails deploy with a clear error rather than creating anything.

`PUT api/instances` is the one endpoint in this app whose request body is
**flat, not JSON:API-wrapped** — verified against
`InstanceUpdateAttributesRequest.get_schema_cls() -> None` in the
`axonius_api_client` source, which causes `BaseModel.dump_request` to skip the
usual `{data:{type,attributes}}` envelope. The body is
`{ nodeIds: "<node_id>", node_name, hostname, use_as_environment_name }` — note
`nodeIds` is a single node_id **string**, not an array (verified against
`api/system/instances.py`'s `_update_attrs`), despite the plural-sounding name.

**Deliberately not managed:** deactivating an instance, and instance tags. Both
have a raw endpoint defined (`api/instances`'s `update_active`, and a `tags`
dict on the read schema), but the `axonius_api_client` maintainers' own
`Instances` wrapper class docstring explicitly lists "Deactivate an instance"
and "Tag an instance" under functionality that is **"not yet exposed"** — so
this config type only drives the fields the maintained client itself
round-trips (`node_name` / `hostname` / `use_as_environment_name`).

## Lifecycle Settings — a partial overlay, not a fixed field list

Axonius's discovery (lifecycle) schedule lives at `GET/PUT
api/settings/plugins/system_scheduler/SystemSchedulerService` — a generic,
version-specific JSON object (verified as the "Lifecycle Settings" plugin/config
pair via `api/system/settings.py`'s `SettingsLifecycle` class). Rather than
guess at internal field names that vary by tenant/version, this is a
**tenant-wide singleton** (declare it at most once per canvas) that takes a
JSON `overrides` object and **shallow-merges it onto the live config at deploy
time**: only the top-level keys you declare are ever changed; every other live
key is read and PUT back exactly as found. Drift detection likewise only
compares the declared keys — a change to a key this config type doesn't manage
is never flagged. Rollback restores the entire prior config verbatim (captured
before the merge). To find the current shape for your tenant, inspect a
`GET` response or the Axonius GUI's **Settings → Lifecycle Settings** page.

## API surface used

All calls are HTTPS (443) with `api-key` + `api-secret` request headers and JSON:API
bodies (`Content-Type: application/vnd.api+json`), except `instances` update
(see above — flat body).

| Operation | Method + path |
| --- | --- |
| Connectivity / health | `GET api/settings/meta/about` |
| List / create / update / delete saved queries | `GET api/queries/saved` · `POST api/queries/{devices\|users}` · `PUT api/queries/{uuid}` · `DELETE api/queries/query/{uuid}` |
| List / get / create / update / delete enforcement sets | `GET api/enforcements` · `GET api/enforcements/{uuid}` · `POST api/enforcements` · `PUT api/enforcements/{uuid}` · `DELETE api/enforcements` |
| List / add / remove tags | `GET api/{devices\|users}/labels` · `PUT api/{devices\|users}/labels` · `DELETE api/{devices\|users}/labels` |
| List / create / update / delete roles | `GET api/settings/roles` · `POST api/settings/roles` · `PUT api/settings/roles/{uuid}` · `DELETE api/settings/roles/{uuid}` (no body) |
| List / create / update / delete users | `GET api/settings/users` · `POST api/settings/users` · `PUT api/settings/users/{uuid}` · `DELETE api/settings/users/{uuid}` |
| Get / create / update / delete data scopes | `GET api/settings/data_scope` · `POST api/settings/data_scope` · `PUT api/settings/data_scope/{uuid}` · `DELETE api/settings/data_scope/{uuid}` (no body) |
| List / update instances | `GET api/instances` · `PUT api/instances` (flat body) |
| Get / update lifecycle settings | `GET/PUT api/settings/plugins/system_scheduler/SystemSchedulerService` |

Create/update body (JSON:API), saved query example:

```json
{ "data": { "type": "views_schema", "attributes": {
  "name": "Windows servers",
  "view": { "query": { "filter": "(specific_data.data.os.type == \"Windows\")" },
            "fields": ["specific_data.data.hostname", "specific_data.data.name"] },
  "description": "", "tags": [], "private": false, "always_cached": false, "asset_scope": false
}}}
```

> **Verify against a live Axonius tenant.** Endpoint paths and shapes follow the
> public [`axonius-api-client`][client] (unversioned `api/...`). Some tenants expose
> a versioned root (`/api/V4.0/`) — set the `api_version` setting if so.

## Development

```bash
# from the repo root
npm run validate apps/axonius        # manifest + canvas + bundle checks
npm test axonius                     # run the app's __tests__
cd apps/axonius && npx tsc --noEmit  # typecheck
```

No database and no BYOL — this app is a thin, API-driven configuration manager.

## Coverage (v0.3.0)

Coverage was audited against the public [`axonius_api_client`][client] source
(`api_endpoints.py` and its `json_api/` request/response schemas) — the
maintained reference for Axonius's REST API surface — on 2026-08-04.

### Managed declarative configuration

| Configuration type | Axonius REST API operations |
| --- | --- |
| Saved queries | `GET api/queries/saved` · `POST api/queries/{devices\|users}` · `PUT api/queries/{uuid}` · `DELETE api/queries/query/{uuid}` |
| Enforcement sets | `GET/POST api/enforcements` · `GET/PUT api/enforcements/{uuid}` · `DELETE api/enforcements` |
| Tags | `GET/PUT/DELETE api/{devices\|users}/labels` |
| Roles | `GET/POST api/settings/roles` · `PUT/DELETE api/settings/roles/{uuid}` |
| Users (internal only) | `GET/POST api/settings/users` · `PUT/DELETE api/settings/users/{uuid}` |
| Data scopes | `GET/POST api/settings/data_scope` · `PUT/DELETE api/settings/data_scope/{uuid}` |
| Instances (attrs, update-only) | `GET api/instances` · `PUT api/instances` |
| Lifecycle settings (partial overlay) | `GET/PUT api/settings/plugins/system_scheduler/SystemSchedulerService` |

Every per-object type reconciles by a stable name/id and captures the prior
definition for rollback; the two settings singletons (lifecycle-settings, and
tags' selection semantics) preserve unknown/undeclared state rather than
overwriting it wholesale.

### Intentionally excluded

- **Adapter connection credentials** (`POST/PUT
  api/adapters/{adapter_name}/connections[/{uuid}]`) — the `connection` body is
  an arbitrary, adapter-specific dict (500+ different adapters, each with its
  own schema) that embeds that adapter's raw secret material (passwords, API
  keys, tokens) **inline**, with no per-field secret indirection the way this
  app's own API key/secret credential has. There is no stable, enumerable
  schema to author as canvas fields without either hardcoding hundreds of
  per-adapter forms or storing raw secrets in canvas JSON — both violate the
  platform's credential-vault-only secrets posture. (Verified against
  `json_api/adapters/cnx_create_request.py`.)
- **Dashboards / charts** (`api/dashboard*`) — the only write path is a bulk
  `POST api/dashboard/import` of an opaque `data` blob captured from a prior
  `export`, controlled by a single `replace: bool`. There is no atomic
  per-chart or per-space create/update/delete endpoint with a typed schema to
  reconcile against, so it cannot be modeled as declarative canvas items with
  per-item identity, diff and rollback the way every other type in this app
  is. (Verified against `json_api/dashboard_spaces.py`.)
- **Reports** — there is no `Reports` endpoint group in the public JSON:API
  surface at all (`ApiEndpointsGroups` lists `instances`, `central_core`,
  `system_settings`, `remote_support`, `system_users`, `system_roles`,
  `lifecycle`, `adapters`, `signup`, `password_reset`, `audit_logs`,
  `enforcements`, `saved_queries`, `assets`, `openapi`, `data_scopes`,
  `dashboard_spaces`, `folders_queries`, `folders_enforcements`, `account` —
  no `reports`). Axonius's Reports feature is GUI/internal-only in this API
  version; there is nothing to bind a config type to.
- **Categories / labels** beyond assets — asset label apply/remove is already
  the `tags` config type. The only other "labels" endpoint (`GET api/labels`)
  is the read-only permission-category descriptor set used to build the
  `roles` config type's `permissions` JSON — there is no separate
  category/label CRUD surface to add.
- **Instance deactivation and instance tags** — see the Instances section
  above: both are explicitly called out as **not yet exposed** by the
  `axonius_api_client` maintainers' own docstring, despite a raw endpoint
  existing for the former.
- **Discovery start/stop, factory reset, CSR/certificate management, remote
  support toggles, central-core settings, GUI/global system settings beyond
  the lifecycle schedule, adapter fetch-history, folders (for queries and
  enforcements), enforcement tasks, audit logs, signup/licensing and account
  login** are either imperative actions (not durable desired state),
  read-only/monitoring surfaces, or narrow Enterprise/bootstrap settings not
  requested for this release — valid candidates for a future version, but out
  of scope here to keep this release's write surface tightly verified.
- **Per-asset data** (device/user records, vulnerabilities, asset
  destroy/enforce-on-selection) is runtime security data, not configuration —
  out of this app's scope entirely, consistent with every other Axonius
  config type in this app.

Primary references: the public [`axonius_api_client`][client] source
(`api_endpoints.py`, `json_api/*.py`, `api/system/*.py`) and each endpoint
cited in the `_shared.ts` file of its config type.

[aql]: https://docs.axonius.com/docs/axonius-query-language-aql
[client]: https://github.com/Axonius/axonius_api_client
