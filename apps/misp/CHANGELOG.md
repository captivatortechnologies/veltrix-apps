# Changelog

All notable changes to the MISP app are documented here.

## 0.3.0 — 2026-07-29

BYOL infrastructure hosting — provision + manage a MISP stack (misp-core / MariaDB /
Redis). Client BYOLPage wraps the SDK `ByolInfrastructureManager`; app-owned `/byol`
routes + `misp_byol_*` tables (migrations 002/003) with a topology resource plan,
deploy (emits a provisioning event), destroy, lifecycle, resources, deployments, and
usage metering.

## 0.2.0 — 2026-07-29

Five more config types (all over the MISP REST API):

- **Taxonomies** / **Warninglists** — enable/disable by namespace/name.
- **Sharing Groups** / **Organisations** — create/edit.
- **Sync Servers** — add/edit remote MISP sync servers (pull/push).

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **Threat Feeds** config type — add / edit / enable / disable MISP threat feeds
  (name, provider, URL, source format, enabled) over the MISP REST API (443), with
  validate / deploy (upsert by feed URL) / rollback (restore prior or disable) /
  health-check / drift-detect / status.
- **Connectivity test** against the MISP REST API (`/servers/getVersion`, HTTPS,
  self-signed tolerated) using a MISP automation key.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (automation
  key → connection → author), and Connections (wraps the SDK `ConnectionsManager`
  for a MISP instance; saving a connection registers `misp-core` as a deploy
  target).
- **BYOL infrastructure** groundwork: declarative `infra/spec.ts` composing the
  generic OpenTofu modules (`misp-core` + `database` MariaDB + `redis`, plus an
  all-in-one `standalone`) + a MISP bring-up entrypoint.

> MISP REST API paths follow 2.4 conventions and should be verified against a live
> MISP 2.4 instance. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.
