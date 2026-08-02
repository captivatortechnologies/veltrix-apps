# Changelog

All notable changes to the JFrog Xray app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-02

### Added
- **Security policies (`security-policies`).** Manage JFrog Xray security
  policies as code through the Xray REST API v2
  (`GET`/`POST`/`PUT`/`DELETE /xray/api/v2/policies[/{name}]`), reconciled by
  policy name. Each policy authors one primary rule via typed fields — a
  minimum severity (`All Severities`/`Critical`/`High`/`Medium`/`Low`) or a
  CVSS v3 range gate, plus build/release-blocking (fail build with an
  optional grace period, block download of unscanned/violating artifacts,
  block release-bundle distribution/promotion), notification (watch
  recipients, deployer, extra emails, webhooks) and ticketing actions — with
  two JSON escape valves (`criteria_json`/`actions_json`) for advanced
  criteria/actions and a third (`additional_rules_json`) for extra rules in a
  multi-tier policy. Ships the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus).
- Deploy captures each policy's full prior body before a `PUT` (Xray has no
  partial update) so rollback can restore it exactly, or delete a policy this
  app created.
- Connection test authenticates with `GET /xray/api/v2/policies` rather than
  the unauthenticated system ping, so a broken or under-scoped Access Token
  is caught at connection-test time, not at first deploy.

### Known limitations (by design, not oversight)
- **Watches are out of scope.** A policy only takes effect once bound to a
  Watch (a separate Xray object). Deferred to a follow-up release rather
  than shipped unverified.
- **Global policies only.** Project-scoped policy writes (`projectKey`) were
  not confirmed against the official REST reference during this build and
  are left out rather than guessed at; only tenant-wide policies are managed.
