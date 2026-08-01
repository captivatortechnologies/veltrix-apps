# Changelog — PagerDuty

All notable changes to the PagerDuty Veltrix app are documented here.

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
