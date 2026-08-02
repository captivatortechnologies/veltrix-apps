# Changelog — Rubrik

All notable changes to the Rubrik app are documented here. The app version is
tracked in `manifest.yaml` and mirrored in `package.json`.

## 0.2.0 — 2026-08-01

Two new configuration types, driven through the full Security-as-Code pipeline.

- **Fileset Templates** configuration type (`/api/v1/fileset_template`): author
  reusable definitions of *what to back up* on a host — OS family plus
  include / exclude / exception path lists (full paths + wildcards) and optional
  backup-script hooks. Upsert by name over `POST`/`PATCH /api/v1/fileset_template`,
  with health check, drift detection (OS type + path sets) and rollback (restore
  prior definition, or delete a created template).
- **Managed Volumes** configuration type (`/api/internal/managed_volume`): declare
  SLA-protected storage targets — channels, size (GiB → bytes), subnet, application
  tag and export host patterns. Upsert by name (channels/size are fixed at
  creation, so an existing volume is PATCHed with only its mutable fields), with
  health check, drift detection and rollback (restore prior export config, or delete
  a created volume).
- New app permissions: `fileset-templates` and `managed-volumes` (read/write/delete).

> Endpoints were verified against the Rubrik CDM v5.0.0-p1 REST postman collection
> and body field names against the Rubrik PowerShell SDK; the exact create/patch
> body shapes (and the fileset `operatingSystemType` `Linux` vs `UnixLike` naming on
> CDM 4.2+) should be verified against a live Rubrik CDM cluster — see the `FLAG`
> notes in each config type's `_shared.ts`.

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
