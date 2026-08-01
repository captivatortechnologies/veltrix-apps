# Changelog — PagerDuty

All notable changes to the PagerDuty Veltrix app are documented here.

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
