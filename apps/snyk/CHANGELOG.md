# Changelog

All notable changes to the Snyk app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
