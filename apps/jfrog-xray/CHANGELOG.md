# Changelog

All notable changes to the JFrog Xray app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

This release exhausts the remaining Xray REST API config-as-code surface: every
policy `type`, the two Xray-native objects that reference policies by name
(webhooks, and — indirectly — watches from 0.2.0), a manually-authored
vulnerability object, and JFrog Curation. See README.md's new **Coverage**
section for the full managed-vs-excluded map.

### Added
- **Operational-risk policies (`operational-risk-policies`).** The third
  policy `type` (`operational_risk`) against the same `/xray/api/v2/policies`
  endpoints as security/license policies. Criteria is either a named minimum
  risk level (High/Medium/Low) or a custom multi-factor rule built from
  project-maturity signals (end-of-life status, release age, release
  cadence, commit/committer activity) combined with AND/OR — verified
  against JFrog's own Terraform provider docs. Shares the CRUD-by-name
  plumbing and actions schema with security/license-policies via
  `lib/xrayPolicies.ts`.
- **Custom issues (`custom-issues`, group "Data").** Manually-authored Xray
  issues (vulnerabilities) for components not covered by Xray's own
  vulnerability database — e.g. an internal package or a vendor advisory
  feed. Applied over `POST /xray/api/v1/events` (create), `GET
  /xray/api/v2/events/{id}` (read — confirmed v2, an asymmetry with the v1
  write endpoints), `PUT /xray/api/v1/events/{id}` (full-replace update) and
  `DELETE /xray/api/v1/events/{id}`. **Unlike every other object in this
  app, the identity is a USER-CHOSEN `id`** (must not start with "Xray"),
  making reconciliation a simple create-or-update-by-id. Two real
  discrepancies were found between JFrog's Terraform provider docs and the
  literal REST reference example for this object during research, both
  resolved in favor of the concrete REST example: the wire field is
  `provider` (not `provider_name`), and a source reference is the simple
  `{"source_id": "..."}` shape (not terraform's richer `id`/`name`/`url`
  form). `type`/`package_type`/`severity` are NOT enum-constrained by Xray's
  own OpenAPI schema (confirmed directly against the schema, not just the
  docs prose) — `type` and `package_type` are offered as free-form
  text/suggested-values rather than a hard-validated enum as a result.
- **Webhooks (`webhooks`, group "Integrations").** Named HTTP callback
  targets that a policy's "Webhooks" action list references by name.
  Applied over Xray's OWN webhook registry — `POST /xray/api/v1/webhooks`,
  `GET`/`PUT`/`DELETE /xray/api/v1/webhooks/{name}` — distinct from the
  JFrog Platform's separate Event/Webhooks service. This endpoint has **no
  dedicated page in the official REST reference** (its full index has zero
  matches for "hook"); the schema was confirmed from JFrog's own Terraform
  provider docs, and the literal wire path was confirmed by reading that
  provider's Go source directly (`resource_xray_webhook.go`'s
  `WebhooksEndpoint`/`WebhookEndpoint` constants) — the highest-confidence
  source available given the doc gap.
- **Curation policies (`curation-policies`, group "Policies").** JFrog
  Curation — package-based governance that blocks (or dry-runs) risky
  open-source package versions before they reach an Artifactory remote
  repository. Served by the Xray REST API under a `/curation` sub-path
  (`/xray/api/v1/curation/policies`), which is why it stays in this app's
  Xray-scoped remit even though Curation is its own JFrog product line.
  Unlike every other named policy object, the write URLs key off a
  **server-assigned `policy_id`**, not the name directly — deploy lists
  policies to match by name, then resolves the id for get/put/delete (with
  a defensive re-list fallback if a create response doesn't echo the new
  id). Update is a **partial** update that explicitly rejects read-only
  fields being sent back (unlike every other policy/watch/webhook object in
  this app, which are full replaces). `waivers`/`label_waivers` are nested,
  variable-length exception lists with their own add/retain(by
  id)/remove(by omission) semantics — exposed as JSON escape valves.
  **`condition_id` is a plain string reference** — this app does NOT manage
  curation condition templates or custom conditions (`custom_curation_condition`
  in JFrog's own provider), a separate, deeper 3-layer object (templates →
  custom conditions → policies) whose full param-value schema (EPSS,
  SpecificVersions, license, CVE, EOL, each shaped differently) was judged
  out of scope for a responsible verification pass this release — see
  README Coverage.
- Sidebar grouping (`group:`) now spans four groups: **Policies** (security,
  license, operational-risk, curation), **Watches**, **Ignore Rules**,
  **Data** (custom issues), **Integrations** (webhooks).
- README.md **Coverage** section: every Xray config-as-code object found via
  JFrog's own Terraform provider's resource list (21 resources, the most
  authoritative enumeration available), marked managed vs. intentionally
  excluded with reasoning and citations for each exclusion.

### Citations (new this release)
- Full Xray declarative-surface enumeration — JFrog's own Terraform
  provider's resource directory listing:
  `github.com/jfrog/terraform-provider-xray/tree/master/docs/resources` (21
  resources; the authoritative source used to decide what else was worth
  building this release, and what to explicitly exclude).
- Operational risk policy criteria — JFrog's own Terraform provider:
  `github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/operational_risk_policy.md`.
- Custom issues — `docs.jfrog.com/security/reference/{create-issue-event,get-issue-events-v2_custom-issues-v2-openapi,update-issue-event,delete-issue-event}`,
  cross-checked against `github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/custom_issue.md`.
- Webhooks — schema from `github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/webhook.md`;
  wire path confirmed from that provider's own Go source
  (`resource_xray_webhook.go`), since no REST reference page exists for it.
- Curation policies — `docs.jfrog.com/security/reference/{createpolicy,listpolicies,getpolicybyid,updatepolicy,deletepolicy}`
  (the curation-specific pages, confirmed by their actual
  `/xray/api/v1/curation/policies` path — NOT the identically-titled legacy
  v1 policy pages), cross-checked against
  `github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/{curation_policy,custom_curation_condition}.md`.

### Known limitations (by design, not oversight)
- **Curation condition templates/custom conditions are out of scope** — see
  Added notes above and README Coverage.
- **Curation policy pagination**: the list call requests up to 500 policies
  in one page; a tenant with more would need follow-up pagination support.
- **Webhook `password` may not round-trip on read** — typical secret-masking
  behavior for APIs with no dedicated reference page to confirm either way;
  drift detection does not compare it, and rollback restores every OTHER
  captured field exactly.
- **Curation / policy-name assumption**: curation policy names are assumed
  unique per the list endpoint's documented name filter; Xray does not
  document an explicit uniqueness constraint the way it does for security/
  license/operational-risk policy names (which are literal URL path
  segments and therefore inherently unique).

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
