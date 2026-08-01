# Changelog

All notable changes to the Axonius app are documented here. The version tracks
`manifest.version`; each bump records what changed for the in-product upgrade
banner.

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
