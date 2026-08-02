# Changelog

All notable changes to the HackerOne app are documented here.

## 0.1.0 — 2026-08-01

Initial foundation.

- **Structured Scopes** configuration type — author a HackerOne program's asset
  scope as code: asset type, asset identifier, submission / bounty eligibility,
  max severity and tester instruction. Deployed over the HackerOne API
  (`https://api.hackerone.com/v1`, HTTP Basic auth, JSON:API).
- Each scope names its target **program by handle**; the handle is resolved to a
  program id via `GET /me/programs`, and the asset is **upserted by identifier**
  within that program (`GET`/`POST /programs/{id}/structured_scopes`,
  `PUT /programs/{id}/structured_scopes/{id}`).
- Full pipeline handler set: `validate`, `deploy`, `rollback`, `healthCheck`,
  `driftDetect`, `getStatus`. Rollback restores prior scope attributes or archives
  scopes this app created.
- HTTP Basic auth API client (`lib/hackeroneApi.ts`) with JSON:API pagination,
  plus a connection connectivity test (`GET /me/programs`).
- Client pages: Overview, Setup Guide, Connections (fixed host `api.hackerone.com`;
  credential = API token identifier as username + token value as secret).
- No BYOL / no database — HackerOne is a pure SaaS API.

### Flagged for verification against live HackerOne

- HackerOne removed the program-level **create / update / archive** structured-scope
  endpoints from its public docs on **2026-04-07** (assets are now managed via
  organization asset-management endpoints). The `GET` (list) endpoint remains
  documented. The write path and request envelope
  (`{ data: { type: "structured-scope", attributes } }`) should be verified against
  the live API — and may need to move to the organization asset-management endpoints.
- The exact `asset_type` machine enum set has varied across API revisions; verify
  the values in the canvas select if any type is rejected.
