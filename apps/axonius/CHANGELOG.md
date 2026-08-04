# Changelog

All notable changes to the Axonius app are documented here. The version tracks
`manifest.version`; each bump records what changed for the in-product upgrade
banner.

## 0.3.0 — 2026-08-04

Five new configuration types, exhausting the rest of Axonius's genuinely
declarative config-as-code write surface (see README.md "Coverage" for the
full audit, including what was deliberately dropped and why). All five are
driven through the full Security-as-Code pipeline (validate, deploy, rollback,
health check, drift detection, status).

- **Roles** (`roles`): manage Axonius roles as code — a named permission set
  (a tenant/version-specific category → action JSON object) plus an optional
  Data Scope restriction. Upsert by role name over `POST/PUT
  api/settings/roles` (predefined built-in roles are never matched/adopted);
  rollback restores the prior definition or deletes a role it created
  (`DELETE api/settings/roles/{uuid}` — no request body, verified
  `request_as_none`).
- **Users** (`users`): manage Axonius-internal system-user accounts (never
  LDAP/SAML/SSO-provisioned ones) and their role assignment. Upsert by
  `user_name` over `POST/PUT api/settings/users`, resolving a declared
  `role_name` to its role id at deploy time. Deliberately never reads or
  writes password material — a created user always gets an
  Axonius-generated password (`auto_generated_password: true`); an updated
  user's password is never touched.
- **Data Scopes** (`data-scopes`): manage named asset-visibility restrictions
  (row-level security) as code — a set of devices/users saved-query
  references a Role can be restricted to. Upsert by name over `POST/PUT
  api/settings/data_scope`, resolving declared saved-query names to their
  uuids via the existing `saved-queries` config type's list endpoint.
  Requires the Data Scopes feature enabled on the tenant (Enterprise).
- **Instances** (`instances`): manage the display name, hostname and
  environment-name flag of EXISTING Axonius instances (cluster nodes) by
  `node_id` — update-only, never creates/deletes/deactivates a node.
  `PUT api/instances` uses a flat (non-JSON:API) request body — verified
  against `InstanceUpdateAttributesRequest.get_schema_cls() -> None`, which
  skips the usual `{data:{type,attributes}}` envelope entirely. Deactivating a
  node and instance tags are excluded — the axonius_api_client maintainers'
  own `Instances` wrapper docstring lists both as "not yet exposed."
- **Lifecycle Settings** (`lifecycle-settings`): a tenant-wide singleton,
  partial top-level JSON overlay onto the discovery (lifecycle) schedule
  settings (`GET/PUT api/settings/plugins/system_scheduler/
  SystemSchedulerService`). Only the top-level keys declared in `overrides`
  are ever touched; every other live key is read, preserved and PUT back
  untouched — the internal schedule schema is version-specific and not
  hardcoded. Rollback restores the prior full config verbatim.
- Endpoints and JSON:API body shapes verified against the `axonius_api_client`
  source (`api_endpoints.py`, `json_api/system_roles.py`,
  `json_api/system_users.py`, `json_api/data_scopes.py`,
  `json_api/instances.py`, `json_api/system_settings.py`,
  `api/system/settings.py`, `api/system/instances.py`). The users delete
  body's `base_schema` type and the instances flat-body shape are both
  source-derived inferences flagged for live-tenant verification.
- Dashboards/charts, reports, adapter connection credentials and
  categories/labels were evaluated and are intentionally NOT covered — see
  README.md "Coverage" for the reasoning behind each.

## 0.2.0 — 2026-08-01

Two new configuration types, both driven through the full Security-as-Code
pipeline (validate, deploy, rollback, health check, drift detection, status).

- **Enforcement Sets** (`enforcement-sets`): manage Axonius enforcement sets as
  code — a named policy with a main action drawn from the action library (an
  `action_name` + a JSON config) plus optional triggers. Upsert by set name over
  `POST/PUT api/enforcements`; rollback restores the prior full definition
  (snapshotted via `GET api/enforcements/{uuid}`) or deletes a set it created;
  drift confirms the set still exists and still runs the declared main action.
- **Tags** (`tags`): apply a named label to every device or user matching an AQL
  filter over `PUT api/{module}/labels`; rollback removes the label from exactly
  the assets it tagged (`DELETE api/{module}/labels`); drift confirms the label
  still exists in the module. Optional expirable-tag expiration date.
- Endpoints and JSON:API body shapes verified against the `axonius_api_client`
  source (`api_endpoints.py`, `json_api/enforcements.py`,
  `json_api/assets/modify_tags_request.py`, `api/assets/labels.py`). Action-config
  internals, trigger objects, and the single-call filter-based tag selection are
  pass-through / inferred and should be verified against a live tenant.

## 0.1.0 — 2026-08-01

Foundation release.

- Manage Axonius (CAASM) **Saved Queries** as code: a named AQL filter over the
  `devices` or `users` module plus the columns to display.
- Full Security-as-Code pipeline for the `saved-queries` configuration type —
  validate, deploy (upsert by name within a module), rollback (restore prior
  definition or delete a created query), health check, drift detection and status.
- Axonius REST access seam (`lib/axoniusApi.ts`): `api-key` + `api-secret` request
  headers, JSON:API bodies (`application/vnd.api+json`), self-signed-tolerant
  HTTPS, optional versioned `/api/<version>/` root via the `api_version` setting.
- Connection connectivity test against `GET api/settings/meta/about`.
- Client pages: Overview, Setup Guide, Connections (API key + secret).
