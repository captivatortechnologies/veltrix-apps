# Changelog

All notable changes to the Cybereason app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and
[semantic versioning](https://semver.org/).

## 0.2.0 — 2026-08-01

### Added

- **Sensor Groups** configuration type (`config-types/sensor-groups`) — manage
  Cybereason sensor groups (name, description, assigned `policyId`, optional
  dynamic `groupAssignRule`) as code, upserted **by name**. Deploy reads the live
  groups (`GET /rest/groups`), then `PUT /rest/groups/{id}` when a group of that
  name exists or `POST /rest/groups` otherwise; rollback restores the prior body
  or `DELETE /rest/groups/{id}?assignToGroupId=…` (reassigning sensors to the
  Unassigned group). Full handler set + tests.
- **Isolation Rules** configuration type (`config-types/isolation-rules`) — manage
  Cybereason isolation (exception) rules (IPv4 `ipAddressString`, `direction`
  `ALL`/`INCOMING`/`OUTGOING`, optional `port` where `0` = any, `blocking` flag).
  The **composite** `ip + direction + port` is the upsert identity (Cybereason
  assigns the server-side `ruleId`). Deploy reads the live rules
  (`GET /rest/settings/isolation-rule`), then `PUT` (carrying the live rule's
  `ruleId` + `lastUpdated` concurrency token) or `POST` to create; rollback
  re-reads live state to reconcile the fresh token, then restores prior values or
  `POST .../isolation-rule/delete`. Full handler set + tests.
- App session client (`lib/cybereasonApi.ts`) gained `putJson` + `del` helpers on
  the authenticated session so the new types can `PUT`/`DELETE` alongside the
  existing `get`/`postJson`.
- Registered both types in `pipeline.configurationTypes` and added
  `sensor-groups` + `isolation-rules` app permissions.

### Notes — honest scope (Cybereason write API is limited beyond reputations)

- **Sensor Groups** and **Isolation Rules** are **confirmed writable** — every
  endpoint (list + create + update + delete) was cross-checked against **two
  independent, real Cybereason clients**: the `forensic-security/cybereason`
  Python SDK (`sensors.py`, `rules.py`) and the `tobor88` PoshCybereason
  PowerShell module. The endpoint strings match verbatim across both.
- **FLAGGED** items to verify against a live tenant: the inner schema of a sensor
  group's dynamic `groupAssignRule` (passed through as opaque JSON — validated
  only for JSON validity), and the exact list-response envelopes + the isolation
  `lastUpdated` optimistic-concurrency semantics. All are marked `VERIFY` /
  `FLAGGED` in the code.
- **Custom Detection Rules was researched and DROPPED.** The endpoints exist
  (`GET /rest/customRules/decisionFeature/live|deleted`,
  `POST /rest/customRules/decisionFeature/create|update`, with a `/rest/v2/…`
  split on newer tenants), but a valid create/update body is a **nested
  Element → Feature → filter graph** requiring correct `elementType` /
  `facetName` / `connectionFeature` values plus `malopDetectionType` /
  `malopActivityType` / `rootCause` enums pulled from separate catalog endpoints —
  not a flat, round-trippable config object, and the official docs warn a bad rule
  can harm retention/performance. It is **not realistically maintainable as
  declarative config from public sources**, so it was dropped rather than shipped
  as a misleading best-effort surface (cf. the Cortex XDR precedent of dropping
  surfaces without a genuine as-code write path).

## 0.1.0 — 2026-08-01

Initial foundation release.

- New Veltrix app **Cybereason** (category **EDR**) managing the Cybereason
  Defense Platform over its REST API.
- Session-cookie access seam (`lib/cybereasonApi.ts`): username / password login
  to `/login.html` → `JSESSIONID` cookie, replayed on every `/rest/...` call.
- **Custom Reputations** configuration type — allowlist / blocklist entries for
  file hashes (MD5 / SHA-1), domains and IPv4 addresses, with a full pipeline:
  validate, deploy (upsert by key via `POST /rest/classification/update`),
  rollback (restore prior verdict or remove), health check, drift detection
  (against `GET /rest/classification/download`) and status.
- Connection-level connectivity test (`handlers/testConnection.ts`): session
  login + a bounded authenticated read.
- Client pages: Overview, Setup Guide, Connections.
