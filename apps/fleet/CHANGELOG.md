# Changelog

All notable changes to the Fleet app are documented here.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **Saved Queries** config type — author osquery saved queries (name, SQL,
  schedule interval, target platform, observer access) and apply them over the
  Fleet REST API (`/api/v1/fleet/queries`), upserting by name, with validate /
  deploy / rollback (restore-prior or delete) / health-check / drift-detect /
  status.
- **Connectivity test** against the Fleet server (`GET /api/v1/fleet/me`, HTTPS,
  self-signed tolerated) using a Fleet API token (Bearer).
- **REST seam** `lib/fleetApi.ts` — `buildFleetUrl` / `buildAuthHeader` /
  `fleetRequest` / `getJson` / `sendJson` over `node:https` (tolerates Fleet's
  self-signed certs).
- **BYOL infrastructure** groundwork: declarative `infra/spec.ts` composing the
  generic OpenTofu modules (`fleet-server` / MySQL `database` / `redis` stack,
  HTTPS front door on 8080) + `fleetctl` bring-up entrypoint.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API token
  → connection → author), and Connections (wraps the SDK `ConnectionsManager` for
  the Fleet server; saving a connection registers it as a deploy target).

> Fleet API paths and payloads follow the documented fleetdm conventions and
> should be verified against a live Fleet (fleetdm) instance.
