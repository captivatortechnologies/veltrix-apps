# Changelog

All notable changes to the Axonius app are documented here. The version tracks
`manifest.version`; each bump records what changed for the in-product upgrade
banner.

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
