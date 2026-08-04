# Changelog — PagerDuty

All notable changes to the PagerDuty Veltrix app are documented here.

## 0.4.0 — 2026-08-04

The manifest previously declared 14 configuration types, but three
(`automation-actions`, `automation-actions-runners`, `service-integrations`)
had no handler directory on disk — every deploy of this app was broken. This
release finishes **Automation Actions** with the full pipeline and removes the
other two from the manifest, with the reasoning recorded below and in the
README Coverage section.

- **Automation Actions** configuration type (`automation-actions`,
  `/automation_actions/actions`): author a script or Process Automation
  action's name, description, `action_type` (immutable once set by PagerDuty —
  deploy fails with a clear error rather than silently delete+recreate),
  `action_data_reference` (shape depends on `action_type`), an optional runner
  reference (by NAME, resolved to an id — the runner itself is not managed by
  this app, see below), classification, invocation flags and team/service
  associations. Associations are attached via
  `POST .../actions/{id}/teams|services` and are **additive only** — removing a
  name from the canvas does not detach it, mirroring how the Tags configuration
  type already handles many-to-many assignment.
- **Removed `automation-actions-runners`** from the manifest (was declared,
  never implemented). Per the official `terraform-provider-pagerduty` resource
  docs, the PagerDuty API can only ever CREATE a `runbook` runner, and doing so
  requires embedding a Runbook Automation API key directly in the plain JSON
  request body — a secret this app's Credential Vault model never stores
  outside the Vault. The other runner type, `sidecar`, self-registers when its
  agent is installed and cannot be created through the API at all. With no safe
  way to create either runner type, a "reconciled by name" config type that
  can never actually create its resource on a first deploy isn't a config type
  this app can honestly offer — see README Coverage.
- **Removed `service-integrations`** from the manifest (was declared, never
  implemented). Every other config type in this app reconciles by listing the
  live collection and matching a declared item by name — but the PagerDuty API
  has no `GET /services/{id}/integrations` list endpoint; an integration can
  only be read back by an id already known to the caller. The official
  Terraform provider confirms this: its `pagerduty_service_integration`
  resource never searches by name, it only ever tracks the id Terraform itself
  stored at creation. A canvas-driven deploy has no equivalent stored state to
  read on a fresh account, so a declarative "does this named integration
  already exist" check cannot be answered without risking a duplicate
  integration on every redeploy — see README Coverage.
- Dropped the now-dangling `automation-actions-runners` and
  `service-integrations` app permissions.
- `app-id` validation now passes clean: 0 errors, 0 warnings.

## 0.2.0 — 2026-08-01

Three new configuration types, each with the full pipeline (validate, deploy —
upsert by name, health check, drift detection and rollback) over the PagerDuty
REST API v2.

- **Services** configuration type (`services`, `/services`): author a service's
  name, description, the escalation policy that backs it (referenced by NAME and
  resolved to an `escalation_policy_reference` at deploy), `auto_resolve_timeout`
  / `acknowledgement_timeout` (seconds) and `alert_creation` mode
  (`create_incidents` / `create_alerts_and_incidents`). Note: PagerDuty has
  deprecated `alert_creation` (all services are migrating to alerts and
  incidents); it is surfaced for parity with existing services.
- **Schedules** configuration type (`schedules`, `/schedules`): author an on-call
  schedule's name, IANA `time_zone` (required) and `schedule_layers` (rotation
  layers with `start`, `rotation_virtual_start`, `rotation_turn_length_seconds`
  and the ordered `users` who rotate). Drift compares presence, time zone and the
  layer count — it does not deep-diff the server-expanded rotation.
- **Teams** configuration type (`teams`, `/teams`): author a team's name and
  description.
- Deploy now reads the account first (list-then-write) so every write is an
  idempotent upsert keyed on the resource name, and records prior state so a
  rollback deletes created resources and restores updated ones.
- Registered all three in `manifest.pipeline.configurationTypes` with matching
  `services` / `schedules` / `teams` app permissions (read / write / delete).

## 0.1.0 — 2026-08-01

Foundation release.

- New Veltrix app **PagerDuty** (category **SOAR**) — manage PagerDuty
  incident-response configuration as code through the PagerDuty REST API v2.
- **Escalation Policies** configuration type (`escalation-policies`): author a
  policy's name, description, loop count (`num_loops`) and escalation rules
  (`escalation_delay_in_minutes` plus user / schedule targets) in the
  Configuration Canvas, then drive it through the full pipeline — validate,
  deploy (upsert by name), health check, drift detection and rollback — over
  `/escalation_policies`.
- REST API v2 client (`lib/pagerdutyApi.ts`): API-key auth
  (`Authorization: Token token=<key>`), the required
  `Accept: application/vnd.pagerduty+json;version=2` header, the fixed
  `https://api.pagerduty.com` base, classic limit/offset pagination and 429
  Retry-After handling.
- Connection-level connectivity test (`GET /abilities`) and the standard
  Overview / Setup Guide / Connections client pages.
- No database and no BYOL — the app is a pure REST passthrough.
