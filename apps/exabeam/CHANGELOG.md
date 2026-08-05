# Changelog

All notable changes to the Exabeam app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Exabeam app, built research-first against the official Exabeam API reference
(`developers.exabeam.com`) and admin guides (`docs.exabeam.com`).

- **Correlation Rules** (`config-types/correlation-rules`) — real-time correlation (detection) rules:
  sequence(s) with an EQL query and trigger condition, severity, enablement, test mode, and optional
  suppression/delay/schedule configuration, via `/correlation-rules/v2/rules`
  (list / get / create / update / delete). Reconciled by rule name (this app's own identity key, since
  the API enforces no native name uniqueness); a canvas item's stable id is tracked across deploys so
  a rename updates the same live rule rather than creating a duplicate. Rules this app created on a
  prior deploy but no longer declares are deleted on reconcile.

Authentication is an Exabeam **API Key** (OAuth2 `client_credentials` grant against
`/auth/v1/token`), with the region (US West / US East / Singapore / Japan / EU / Australia / Canada /
Switzerland / South America / UK) as an app setting — there is no per-tenant id in Exabeam's API URLs,
so the connection's endpoint field is unused by this app and exists only to satisfy the platform's
deploy-target registration. The token client caches per Exabeam's own guidance (~4 hour tokens, capped
at ~6 requests/24h per key) rather than re-authenticating per request.

**This is an intentionally narrow release.** Research found Correlation Rules to be the *only*
configuration surface in the New-Scale platform's public API with a genuinely complete
create/read/update/delete lifecycle as of 2026-08. Analytics (UEBA) rules, case/incident management,
case queues/stages, detection grouping rules, context tables, watchlists, RBAC roles, log
sources/parsers, and automation playbooks were all investigated and found to be either read-only,
create-only with no delete/rollback path, or without any public REST surface at all. See **Coverage**
in `README.md` for the full, sourced breakdown of each.
