# Changelog

All notable changes to the JFrog Xray app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-02

### Added
- **Watches (`watches`).** Manage JFrog Xray watches as code through the same
  v2 policies-adjacent REST surface
  (`GET`/`POST`/`PUT`/`DELETE /xray/api/v2/watches[/{name}]`), reconciled by
  watch name. This is what makes a security or license policy actually take
  effect — a watch scopes resources (typed: all repositories, or one named
  repository with an optional Artifactory server id and package-type
  filters; a JSON escape valve covers builds, release bundles, projects and
  git repositories) and binds policies to that scope by name and type
  (`security_policy_names` / `license_policy_names`, typed as separate tag
  fields since this app manages those two policy types). Also covers watch
  recipients and Jira ticket-creation. Deploy captures each watch's full
  prior body before a `PUT` (no partial update) for exact rollback.
- **License policies (`license-policies`).** A policy of `type: "license"`
  against the identical `/xray/api/v2/policies` endpoints as
  security-policies — allowed/banned OSS license lists, "flag unknown
  licenses", and "permissive on multi-license components" as the criteria,
  with the exact same build/release-blocking, notification and ticketing
  actions (the actions schema is policy-type-agnostic, confirmed against
  JFrog's own Terraform provider docs). The `/policies` CRUD-by-name
  plumbing and the actions schema are now shared with security-policies via
  a new `lib/xrayPolicies.ts` module rather than duplicated.
- **Ignore rules (`ignore-rules`).** Manage JFrog Xray ignore rules — CVE/
  vulnerability/license/scope-filtered violation suppression, with an
  optional expiry — through the Xray REST API v1
  (`GET`/`POST /xray/api/v1/ignore_rules`, `DELETE /xray/api/v1/ignore_rules/{id}`).
  Unlike every other config type here, Xray assigns **no user-chosen name**
  to an ignore rule and exposes **no update endpoint** for it (verified
  against the official reference index — only create/list/get/delete pages
  exist). Reconciliation therefore keys off the **canvas item's own stable
  id**, tracked through `rollbackData` across deploys (the
  platform-documented pattern for a server-assigned identity); a content
  change deletes the old rule and creates a new one instead of an update.
  Drift detection for this type checks existence only — content cannot
  drift here, since nothing (including a manual console edit) can mutate a
  created rule.
- Sidebar grouping (`group:` on every configuration type): **Policies**
  (security-policies, license-policies), **Watches**, **Ignore Rules**.

### Changed
- Refactored `security-policies` to use the new shared `lib/xrayPolicies.ts`
  module (CRUD-by-name primitives + the actions schema) instead of
  duplicating logic now shared with `license-policies`. No behavior change —
  covered by the existing test suite, all still green.

### Citations (new this release)
- Watches — `docs.jfrog.com/security/reference/{create-watch,get-watches,get-watch,update-watch,delete-watch}_watches-v2-openapi`
  and JFrog's own Terraform provider
  (`github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/watch.md`)
  for exact field names/casing (`bin_mgr_id`, `filter.type`/`filter.value`).
- License policies criteria/actions — JFrog's own Terraform provider
  (`github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/license_policy.md`).
- Ignore rules — `docs.jfrog.com/security/reference/{create-ignore-rule,get-ignore-rules,get-ignore-rule,delete-ignore-rule}`.
  The create response's `info` message (`"Successfully added Ignore rule
  with id: <uuid>"`) is the ONLY place the new id appears — confirmed no
  separate `id` field or `Location` header exists.

### Known limitations (by design, not oversight)
- **Project-scoped watches/policies are still out of scope.** As with
  0.1.0's security-policies, only tenant-wide (global) objects are managed.
- **Ignore-rule content cannot be edited in place** — this is an Xray API
  constraint (no update endpoint), not a gap in this app; a declared change
  recreates the rule under a new id, which the canvas/rollback design
  accounts for explicitly (see `config-types/ignore-rules/deploy.ts`).
- **Assigned-policy references are not live-validated.** A watch's
  `security_policy_names`/`license_policy_names` are not checked against
  Xray at validate time — a typo surfaces as an Xray-side deploy error
  instead, consistent with how other apps in this repo handle cross-config
  references (e.g. Wiz automation rules' `integration_id`).

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
