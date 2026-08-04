# Changelog — Rubrik

All notable changes to the Rubrik app are documented here. The app version is
tracked in `manifest.yaml` and mirrored in `package.json`.

## 0.3.0 — 2026-08-04

Three new configuration types, exhausting the genuinely-declarative,
non-secret slice of the Rubrik CDM config-as-code surface.

- **Organizations** configuration type (`/api/internal/organization`): declare
  multi-tenancy containers that partition SLA domains, filesets and users.
  Create-by-name (`POST`), with rollback deleting only the organizations this
  deploy created (there is no verified rename endpoint, so an organization
  that already exists is left untouched).
- **Syslog Configuration** configuration type (`/api/internal/syslog`): declare
  the cluster's single syslog export target (hostname, protocol, port) for
  centralized log forwarding. A cluster singleton with no `PATCH` — a changed
  target is applied as delete-then-create — with health check, drift detection
  and rollback (restore the prior target, or clear it if none existed before).
- **Global Cluster Settings** configuration type (`/api/v1/cluster/me` +
  `/api/internal/cluster/me/*`): declare cluster name, timezone, geolocation,
  DNS nameservers/search domains, NTP servers and the login banner as one
  cluster-singleton item. Five independent read-then-write-if-different steps,
  each converging without a needless write; rollback restores each area's
  captured prior value independently.
- New app permissions: `organizations`, `syslog-config` and
  `global-cluster-settings` (read/write/delete).
- README "Coverage" section documents every configuration type covered and,
  with citations, every candidate type that was evaluated and honestly
  excluded (LDAP/AD, SMTP, local users, roles, SNMP, replication targets,
  archival locations, certificate management, guest OS credentials) — nearly
  all because the only verified create/update endpoint embeds a secret
  (a bind/SMTP/user password, or a target-cluster/cloud credential) directly
  in the request body, which this app's config-as-code canvas has no facility
  to hold.

> Endpoints were verified against the Rubrik PowerShell SDK's API data
> (`Rubrik/Private/Get-RubrikAPIData.ps1`) and the Rubrik Python SDK's
> `rubrik_cdm/cluster.py` (`configure_syslog`, `configure_dns_servers`,
> `configure_ntp`, `configure_login_banner`, `configure_cluster_location`,
> `configure_timezone`) — see the README "Coverage" section for the full
> source list. The exact body shapes should still be confirmed against a live
> Rubrik CDM cluster; see the `FLAG` notes in each new config type's `_shared.ts`.

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
