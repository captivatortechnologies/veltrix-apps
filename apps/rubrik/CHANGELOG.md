# Changelog — Rubrik

All notable changes to the Rubrik app are documented here. The app version is
tracked in `manifest.yaml` and mirrored in `package.json`.

## 0.1.0 — 2026-08-01

Initial foundation.

- Rubrik CDM (Cloud Data Management) app scaffold — category **COMPLIANCE**.
- **SLA Domains** configuration type (backup policies): author snapshot
  frequencies and retention per tier (hourly / daily / weekly / monthly) and
  drive them through the full Security-as-Code pipeline — validate, deploy
  (upsert by name over `POST`/`PATCH /api/v2/sla_domain`), health check, drift
  detection and rollback (restore prior body, or delete a created policy).
- Rubrik access seam (`lib/rubrikApi.ts`): service-account session
  (`POST /api/v1/service_account/session` → Bearer token) over HTTPS, tolerant of
  a cluster's self-signed certificate (enforce with the `verify_tls` setting).
- **Connections** page + connectivity test: opens a service-account session and
  reads `GET /api/v1/cluster/me`.
- Overview and Setup Guide pages built on the platform design-system components.

> API shapes follow the Rubrik CDM 8.x v2 REST conventions and should be verified
> against a live Rubrik CDM cluster (see README "Verify against a live cluster").
