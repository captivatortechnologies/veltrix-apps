# Changelog

All notable changes to the Fleet app are documented here.

## 0.5.0 — 2026-08-04

Coverage exhaustion of the Fleet REST API's config-as-code write surface — seven
more config types, all reusing `lib/fleetApi.ts` (extended with a small
multipart/form-data encoder and a paginated-list helper):

- **Configuration Profiles** (`config-profiles`, group MDM) — macOS/iOS/iPadOS
  `.mobileconfig`/declaration (DDM) JSON and Windows XML OS settings profiles,
  per team or "Unassigned". Fleet's batch endpoint is a whole-list replace per
  scope; deploy snapshots every existing profile's content (downloading each)
  before replacing, so rollback restores the scope's exact prior state.
- **Scripts** (`scripts`, group Scripts) — the Fleet scripts library. The only
  multipart/form-data config type in this app (Fleet has no JSON path for
  script upload), upserted by filename within a team scope.
- **Software** (`software`, group Software) — Fleet-maintained apps and Apple
  App Store / Google Play (VPP) apps made available for install, per team.
  Custom uploaded package binaries are intentionally excluded (see README).
- **Enroll Secrets** (`enroll-secrets`, group Enrollment) — Fleet's valid
  enroll secrets, globally or per team; a whole-list replace per scope with
  full drift detection (Fleet returns enroll secrets in plaintext on read).
- **Global Settings** (`global-settings`, group Configuration) — a singleton
  covering the non-secret slice of Fleet's org config: organization info,
  server settings, features, host/activity expiry and webhooks. Deploy reads
  the current config first and merges declared fields in, leaving every other
  field (and section) untouched.
- **MDM Settings** (`mdm-settings`, group MDM) — OS update deadlines, disk
  encryption enforcement and setup-experience toggles, globally or per team
  (Fleet Premium team overrides).
- **Calendar Integrations** (`calendar-integrations`, group Integrations) —
  the per-team calendar-automation enable/webhook toggle. The org-wide half
  (a Google service-account API key) is credential material and is
  deliberately not managed here.

`lib/fleetApi.ts` gained `buildMultipartBody`/`sendMultipart` (a small RFC 2388
encoder over `node:https`, used by Scripts) and `getAllPages` (pages a Fleet
list endpoint via `meta.has_next_results`, used by Configuration Profiles and
Scripts). See the README **Coverage** section for the full audited surface,
including what was intentionally excluded and why.

## 0.4.0 — 2026-07-30

Generic topology: the BYOL dialog now shows Fleet's own tiers (**Database
nodes** / **Fleet servers**) instead of the SDK's former Splunk-shaped
indexer/search-head labels, via the `ByolInfrastructureManager`'s new
app-declared `topology` prop. The stack's per-tier counts + placement are now
also persisted generically (`node_tiers`, migration 004), alongside the
existing `indexer_count`/`search_head_count` columns which are kept (and still
written) for `lib/byolTopology.ts`. `POST`/`PUT /byol` accept the SDK's
`tiers: [{ key, count, placement }]` body shape (preferred) with the legacy
`indexerCount`/`searchHeadCount`/`indexerPlacement`/`searchHeadPlacement`
fields as a back-compat fallback; `GET` routes now also return `tiers` on
each record.

## 0.3.0 — 2026-07-29

BYOL infrastructure hosting — provision + manage a Fleet stack (fleet-server / MySQL /
Redis). Client BYOLPage wraps the SDK `ByolInfrastructureManager`; app-owned `/byol`
routes + `fleet_byol_*` tables (migrations 002/003) with a topology resource plan,
deploy (emits a provisioning event), destroy, lifecycle, resources, deployments, and
usage metering.

## 0.2.0 — 2026-07-29

Four more config types (all over the Fleet REST API):

- **Global Policies** — pass/fail osquery compliance checks.
- **Labels** — dynamic (osquery-SQL) host labels.
- **Teams** — host segmentation (Fleet Premium).
- **Agent Configuration** — the org-wide `agent_options` singleton (JSON).

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
