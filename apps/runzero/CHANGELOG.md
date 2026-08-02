# Changelog

All notable changes to the runZero Veltrix app are documented here.

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
