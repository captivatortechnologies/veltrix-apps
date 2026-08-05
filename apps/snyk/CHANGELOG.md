# Changelog

All notable changes to the Snyk app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-05

### Added
Research-first pass against Snyk's live OpenAPI spec (`GET /rest/openapi/{version}`,
both the `2024-10-15` and `2026-03-25` dated revisions) and the v1 docs — five
genuinely new, declarative, round-trippable config types (13 total):

- **Org Ignore Policies config type** (`snyk-org-ignore-policies`). Manages
  org-level Snyk Code ignore policies as code via the REST Policies API
  (`GET`/`POST /orgs/{org}/policies`, `PATCH`/`DELETE /orgs/{org}/policies/{id}`).
  Verified this API is documented as "only available for use with Code
  Consistent Ignores" — it is scoped to a Snyk Code finding identity
  (`snyk/asset/finding/v1`), not a general security/license policy engine — and
  is reconciled by policy **name** (Snyk generates the policy id on create,
  same convention as `snyk-service-accounts`). Reuses the same three ignore
  classifications as `snyk-project-ignores` (not-vulnerable, wont-fix,
  temporary-ignore). The policy **review/approval** field is intentionally
  never read or written (a human-approval action, not config). Also verified
  the `2024-10-15` revision of this endpoint is deprecated-by `2026-03-25` and
  sunset-eligible 2026-09-22 with an **identical** request/response shape
  across both revisions — validation now warns when the org's `api_version`
  setting is still on/before the deprecated revision.
- **Org Memberships config type** (`snyk-org-memberships`). Grants, changes or
  revokes an **existing** Snyk user's org role as code via the REST API
  (`GET`/`POST /orgs/{org}/memberships`, `PATCH`/`DELETE /orgs/{org}/memberships/{id}`,
  GA since `2024-08-25`). Reconciled by the target user's Snyk user id — `POST`
  requires it and there is no email-based create, so onboarding a brand-new
  external user remains Snyk's own invite flow (out of scope, documented in the
  README). Never prunes a membership it did not declare, so a deploy can never
  lock an operator out of their own org.
- **Project Attributes config type** (`snyk-project-attributes`). Manages an
  existing project's classification metadata — business criticality,
  environment, lifecycle, tags, owner and test frequency — via the REST API
  (`GET`/`PATCH /orgs/{org}/projects/{project_id}`, GA since `2024-05-31`).
  Distinct from the existing v1 `snyk-project-settings` (pull-request-test /
  auto-dependency-upgrade booleans): this is a different REST resource with a
  different field set. `test_frequency` is written via PATCH's flat shorthand
  but reported on GET under `settings.recurring_tests.frequency` — verified via
  the OpenAPI schema and handled accordingly. Declarative: the three
  classification arrays and tags are always sent (clearing prior values when
  left empty); `test_frequency` and the owner relationship are sent only when
  the operator sets them, so an unmanaged value is never touched.
- **Infrastructure as Code Settings config type** (`snyk-iac-settings`). GET/PATCH
  `/orgs/{org}/settings/iac` (GA since `2021-12-09`) — this **corrects** a prior
  README claim that "IaC has no equivalent org-level settings endpoint to
  SAST." The endpoint exists, but configures an OCI-hosted **custom-rules
  bundle** IaC evaluates alongside its built-in rules (`is_enabled`,
  `inherit_from_parent`, `oci_registry_url`, `oci_registry_tag`) — not a simple
  on/off toggle like SAST. A singleton org setting.
- **Secrets Settings config type** (`snyk-secrets-settings`). GET/PATCH
  `/orgs/{org}/settings/secrets`, the same singleton-toggle shape as
  `snyk-sast-settings`. Snyk's OpenAPI spec tags this operation
  `x-snyk-api-stability: beta` ("Early Access") — documented plainly in the
  canvas help text, manifest description and README rather than hidden.
- Every new type ships the same drift attribution ("who changed it + when")
  convention as the existing types, reconciliation that never prunes
  unmanaged objects, and a `group:` sidebar grouping — now applied to all 13
  config types (Organization Settings / Policies & Ignores / Projects /
  Integrations & Import / Access & Automation).

### Fixed
- README's "Out of scope" claim that IaC has no org-level settings endpoint was
  incorrect (see `snyk-iac-settings` above) — replaced with a verified,
  sourced **Coverage** section listing every managed and excluded surface with
  its reason.

## 1.2.0 — 2026-07-26

### Added
- **Project Settings config type** (`snyk-project-settings`). Manages an existing
  Snyk project's pull-request test and automatic dependency-upgrade settings as
  code via the v1 API (`GET`/`PUT`/`DELETE
  /org/{org}/project/{project}/settings`). Reconciled by project id; the deploy
  captures each project's prior settings and PUTs the managed keys, so rollback
  restores the prior values (or resets a previously-unset project to inherit its
  integration defaults via `DELETE`). Drift compares each managed setting against
  the live project.
- **Project Ignores config type** (`snyk-project-ignores`). Manages Snyk project
  issue ignores (ignore rules) as code via the v1 Ignores API
  (`GET`/`PUT`/`DELETE /org/{org}/project/{project}/ignore/{issueId}`). Reconciled
  by the (project id, issue id) pair; the deploy uses `PUT` ("Replace ignores")
  so the declared rule becomes the issue's ignore, an idempotent upsert.
  Supports the three Snyk classifications (`not-vulnerable`, `wont-fix`,
  `temporary-ignore`, the last requiring an expiry). Rollback removes an ignore
  this deploy added, or restores the prior rule it replaced.
- **Import Targets config type** (`snyk-import-targets`). Imports source-control
  repositories into Snyk as projects through a configured integration via the v1
  Import API (`POST /org/{org}/integrations/{integrationId}/import`) — creating
  projects, not just changing settings on existing ones. Reconciled by target
  (`owner/name`): the deploy lists the org's targets (REST Targets API) and skips
  any that already exist, so re-deploys are idempotent. The import is
  asynchronous, so the deploy records the import job URL from the `Location`
  header; rollback deletes a target this deploy created (also removing its
  imported projects), tolerating a target that has not materialized yet.
- Each new type ships drift attribution ("who changed it + when") consistent with
  the existing types, and the shared Snyk client now exposes response headers
  (used to capture the async import job URL).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Snyk object (SAST settings, notification settings, SCM/registry
  integration settings, service accounts and webhooks), each reported difference
  is now annotated with the person who made the last manual change and when,
  resolved from the Snyk **Audit Logs** REST API
  (`GET /rest/orgs/{org_id}/audit_logs/search`). The platform stores the `actor`
  on each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - Attribution queries the org audit log once per drifted object over a ~7-day
    window (`sort_order=DESC`), then correlates each event to the target
    **client-side**: per-object types (integrations, service accounts, webhooks)
    match the object's Snyk id or name/URL inside the event `content`;
    org-singleton types (SAST, notifications) match by event-name prefix
    (`org.sast_settings` / `org.settings`, `org.notification_settings` / …) — so
    an unrelated object's change is never mis-attributed.
  - It picks the most recent event with a **resolvable acting user**
    (`userId` / `user_id` / `user_public_id`), preferring change-type events
    (`.edit`, `.create`, `.add`, `.delete`, `.remove`, …) and falling back to the
    most recent usable event otherwise. `at` = the event `created`,
    `eventType` = the event name.
  - Veltrix's own deploys authenticate with the connection's service-account
    token, so their audit events are excluded via the connection identity
    (`veltrixActorLogins`), leaving the attribution on the *manual* change rather
    than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an unreachable/forbidden audit scope, an empty log, or
    no usable event, the diff is reported without an actor. Only objects that
    actually drifted are queried (one audit query per drifted object).
