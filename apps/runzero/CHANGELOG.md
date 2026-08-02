# Changelog

All notable changes to the runZero Veltrix app are documented here.

## 0.2.0 — 2026-08-01

Adds two scan-lifecycle configuration types alongside Sites.

- **Scan Tasks** configuration type — manage recurring scans of a Site as code: name,
  target scope, frequency (once / hourly / daily / weekly / monthly / continuous) and
  optional tuning (excludes, TCP ports, rate, tags, template), applied over the runZero
  console REST API.
  - Deploy upserts a recurring scan by `(site, scan name)`: `PUT /org/sites/{site}/scan`
    (runZero creates scans with **PUT**, not POST) to schedule, `PATCH /org/tasks/{id}` to
    update an existing recurring task. A `once` scan runs one-off and is not drift-tracked.
  - Rollback stops schedules this deploy created (`POST /org/tasks/{id}/stop` — runZero has
    no delete-a-task verb) and restores updated tasks to their prior body.
  - Drift detection confirms each recurring scan still exists and its frequency matches;
    a missing scan is critical drift.
  - Health check verifies the org's task list is reachable and the key authenticates
    (`GET /org/tasks`).
- **Scan Templates** configuration type — manage reusable, named scan-parameter sets a scan
  task can be based on, with full CRUD over `/account/tasks/templates` (list / create via
  **POST** / update via **PUT** the full object / delete by id).
  - Deploy upserts by template name; rollback deletes created templates and restores updated
    ones. Drift compares description, the global flag and the parameter map.
  - **Scope note:** scan templates are **account-scoped** resources in runZero, so this
    configuration requires the connection's API key to be an **account-scoped** key — an
    Organization key is rejected by `/account/*` (surfaced by the health check). The target
    organization is resolved from `GET /org` (or an explicit Organization ID field).

Dropped from the original scope after checking the runZero OpenAPI spec: **hosted-zones**
(read-only — `GET` only, not a deploy target), **credentials** (exist only under
`/account/credentials`, create+delete only with no update verb, and carry secrets — a poor fit
for upsert/drift) and **saved queries** (no saved-search endpoints exist in the API).

## 0.1.0 — 2026-08-01

Initial foundation.

- **Sites** configuration type — manage runZero Sites (the scan-scope containers
  assets are grouped under) as code: name, description and the default scan scope
  (subnets/CIDRs), applied over the runZero console REST API (`/org/sites`).
  - Deploy upserts each site by name: `PUT /org/sites` to create, `PATCH /org/sites/{id}`
    to update.
  - Rollback deletes sites this deploy created and restores updated sites to their
    prior body.
  - Drift detection compares description and scan scope (set-based) and flags a
    missing site as critical drift.
  - Health check verifies the org is reachable and the API key authenticates
    (`GET /org/sites`).
- **Connections** page + connectivity test — one connection per runZero organization,
  reached at the hosted console (`console.runzero.com`, overridable for self-hosted
  runZero Platform) and authenticated by an Organization API key (Bearer). The test
  calls `GET /org/sites`.
- **Overview** and **Setup Guide** pages.
- No database and no BYOL — runZero is a SaaS reached over its REST API.
