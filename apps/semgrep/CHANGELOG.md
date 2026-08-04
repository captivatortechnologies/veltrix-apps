# Changelog

All notable changes to the Semgrep app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added — Detection Policy + Remediation Policies (Policies V2 `[Beta]`)

A full re-audit of Semgrep's write surface — **both** the public v1 OpenAPI spec
(`https://semgrep.dev/api/v1/public_v1.openapi.yaml`) and the v2 spec
(`https://semgrep.dev/api/v2/openapi.yaml`, documented at
`https://docs.semgrep.dev/api-reference/v2/`) — found that the v1 `PoliciesService`
this app previously rejected (0.2.0 CHANGELOG: *"considered and rejected — it is
marked `deprecated: true`"*) has a real, documented, **non-deprecated**
replacement: **Policies V2** (`PoliciesV2Service`, `[Beta]`). Its own description
in the v1 spec says as much: *"Use the Policies V2 API instead… this service
stops working after the migration."* Two new configuration types build on it:

- **Detection Policy** (`config-types/detection-policy`) — the deployment-wide
  rule **selection** for Semgrep Code (SAST) or Semgrep Secrets: registry
  rulesets, individually added rules, explicitly disabled rules, and
  per-project/tag include/exclude exceptions. One item per product.
  - **Write path (REAL):** `PUT /api/policies/v2/deployments/{id}/detection-policy/{product}`
    — a **strict, optimistically-concurrent** whole-bundle replace: the submitted
    bundle overwrites rule selection and deletes any exception not in it. Guarded
    by an `If-Match: state_version` header (`428` if missing, `409` with the
    current version if stale — this app re-reads and retries **exactly once**,
    `lib/semgrepApi.ts`'s `applyWithOptimisticRetry`).
  - **Read path (drift + rollback snapshot):** `GET` the same path.
  - **Live validate-time pre-flight:** `POST .../detection-policy/{product}:dryRun`
    — validates a candidate bundle and returns the diff a strict apply would
    produce, without writing. `validate.ts` runs this (best-effort, only when a
    connection is available) and surfaces any `validation_errors` Semgrep itself
    reports — a stronger guarantee than the static structural checks alone.
  - **FLAGGED:** `[Beta]` Policies V2 surface; the targeted product must already
    be **enabled** for the deployment (404 `PRODUCT_NOT_ENABLED` otherwise).

- **Remediation Policies** (`config-types/remediation-policies`) — the
  deployment's **whole** bundle of named policies: conditions (severity,
  confidence, repository tag, …) that fire actions (`block`, `pr_comment`,
  `jira`, `slack_app`, `webhook`, `triage`) when a finding matches. The declared
  item list **is** the bundle.
  - **Write path (REAL):** `PUT /api/policies/v2/deployments/{id}/remediation-policies`
    — same strict, `If-Match`-guarded whole-list replace; a policy absent from
    the submitted list is **deleted**. System-managed policies never appear in
    the bundle and are unaffected; a slug colliding with one fails with
    `RESERVED_SLUG`.
  - **Read path + live dry-run:** mirrors Detection Policy
    (`GET` / `POST .../remediation-policies:dryRun`).
  - **FLAGGED:** `[Beta]` Policies V2 surface. Companion-action requirements
    (e.g. `block` requires `pr_comment` in the same policy) and accepted
    condition/action values are enforced **live** by the dry-run, not duplicated
    client-side — discoverable at any time via
    `GET /api/policies/v2/deployments/{id}/vocab?product=remediation`.

Both types author their nested, per-entry-typed content (exceptions /
conditions / actions) as a JSON array in a textarea, in the API's **exact**
wire shape (snake_case field names) — the canvas has no first-class nested-list
field type (the same constraint cisco-meraki's Group Policies / L7 rule "value"
object hit), and authoring in the wire shape keeps a hand-written bundle aligned
with Semgrep's own docs and dry-run error messages.

### Changed

- `lib/semgrepApi.ts` — added the Policies V2 client surface: `getDetectionPolicy`,
  `applyDetectionPolicy`, `dryRunDetectionPolicy`, `getRemediationPolicies`,
  `applyRemediationPolicies`, `dryRunRemediationPolicies`, `getPolicyVocab`,
  `resolveDeploymentId` (Policies V2 keys on the numeric deployment id, not the
  slug — resolved from the same `GET /deployments` call that discovers the
  slug), plus response helpers (`detectionPolicyBundleFromResponse`,
  `remediationPoliciesBundleFromResponse`, `stateVersionFromResponse`,
  `validationErrorsFromResponse`, `deploymentIdFromResponse`) and the generic
  `applyWithOptimisticRetry` concurrency helper. The `request()` method was
  refactored onto a shared `doRequest` (now also backing the new `requestV2`,
  which supports extra headers and targets the Semgrep root host — Policies V2
  paths carry their own `/api/policies/v2/...` prefix, not the fixed v1 base
  URL). No change to existing v1 methods or their behavior.
- `lib/canvas.ts` — added `stringSetEqual`, a generic order-insensitive string-set
  comparison shared by Detection Policy's drift (and available to future types).
- Manifest registers the two new `configurationTypes` (group `"Policies"`) and
  their `app` permission resources; bumped to 0.3.0 (additive, MINOR). README
  documents both, updates the API/auth section for the two-API-family reality,
  and gains a re-audited **Coverage** section covering v1 + v2 together;
  DATAFLOW.md regenerated.

### Notes — what "exhausted" now looks like for Semgrep

- Re-auditing the v2 spec surfaced roughly 200 additional operations under
  `/api/agent/...`, `/api/scm/...`, `/api/sca/...`, notifications, SCM app
  installs, RBAC, AI "memories", and more. Nearly all are marked `Experimental`
  in the spec (*"not originally designed for third-party use… expect
  significant breaking changes"*), several (`IgnoresService`, most `/api/agent/`
  read paths) are reachable **only** with a logged-in user's session token
  (`SemgrepJWT`) and not this app's API token (`SemgrepWebToken`) at all, and a
  few (`managed_scan_settings`) carry no maturity badge or description
  whatsoever. None of these clear the bar for a production config-as-code type;
  see the README's Coverage section for the full classification and reasoning
  per family.
- **RBAC Teams** (`[Beta]`, API-token-reachable) is the one genuinely viable
  surface left on the table — deferred as out of this app's AppSec-configuration
  scope (it manages org access, not scanning policy), the same boundary Cisco
  Meraki draws around organization-wide administrators.
- **No custom-rule-upload endpoint exists** in either spec — rule *content*
  remains repo-side / Semgrep-Registry-side; only rule **selection** (which
  rulesets/rules run) is a platform config object, which Detection Policy now
  manages.
- With Detection Policy + Remediation Policies added, Semgrep's non-deprecated,
  API-token-reachable, third-party-safe (`Stable`/`Beta`) write surface is
  considered **exhausted** for this app's scope.

## 0.2.0 — 2026-08-01

### Added — two more write-backed configuration types

Research of the official OpenAPI spec (`https://semgrep.dev/api/v1/public_v1.openapi.yaml`)
was the basis for these additions. **Semgrep's platform write surface is genuinely
limited** — config-as-code for Semgrep is mostly the **repo-side rules** (`.semgrep.yml`
/ registry rulesets in the codebase), not platform objects. Of the write endpoints
the API does expose, only two beyond project settings are non-deprecated and a
sensible fit for the pipeline; both are added here with their real endpoints and
honest caveats. (`PUT .../policies/{id}` was **considered and rejected — it is
marked `deprecated: true` in the spec**. Ticketing, dependency-upload and SBOM-export
endpoints are actions/jobs, not configuration, and are out of scope.)

- **Managed Scan Settings** configuration type (`config-types/managed-scan`) —
  toggles Semgrep **Managed Scans** (Semgrep-hosted scanning) for an existing
  project: weekly **full scans** and **diff-aware (PR) scans**.
  - **Write path (REAL):** `PATCH /deployments/{slug}/projects/{name}/managed-scan`
    with body `{ full_scan: { enabled }, diff_scan: { enabled } }`.
  - **Read path (drift + rollback snapshot):** the project's `managed_scan_config`
    from `GET /deployments/{slug}/projects/{name}` — so drift and rollback are both
    fully real, not best-effort. Identity is the project name.
  - **FLAGGED:** Managed Scans is a **`[Beta]`** surface in the spec
    (`ManagedScanConfig` is described as `[Beta]`) and only applies to projects
    **onboarded to Managed Scanning**; a project that is not onboarded (or a
    deployment without Managed Scanning) **fails the deploy with a clear message**.
    As with project settings, there is **no create-project API** — the project must
    already exist.

- **Findings Triage** configuration type (`config-types/triage`) — declares a named
  **triage rule** (a finding selection + a desired triage state) and applies it.
  - **Write path (REAL):** `POST /deployments/{slug}/triage` (bulk triage) — moves
    the findings matching the selection to a triage state
    (`ignored` / `reviewing` / `fixing` / `reopened` / `provisionally_ignored`),
    with an optional reason/note.
  - **Read path (best-effort drift):** `GET /deployments/{slug}/findings`.
  - **FLAGGED — this is IMPERATIVE, not declarative.** Semgrep has **no
    triage-rule resource**: the API only offers a bulk *action*. So this type
    models the rule **locally** and deploy **re-applies** it to whatever findings
    match *right now*.
    - **Findings are a moving target** — new scans surface new findings, so a
      triage does not automatically cover *future* findings; re-deploy re-applies.
    - **Drift is best-effort** — it re-queries `GET /findings` for findings that
      still match the selection at its source status (i.e. not yet triaged) and
      reports the count.
    - **Rollback is best-effort** — it re-triages the **exact finding ids** this
      deploy changed back to `reopened` (recorded in `rollbackData`); it cannot
      restore a finding's *prior* per-finding triage reason/note.
    - Enforced API rule: `new_triage_reason` is only valid with
      `new_triage_state=ignored`. Safety guardrail: a rule **must** set a narrowing
      filter (repositories, rules, or severities) so it can never triage an entire
      deployment.

### Changed

- `lib/semgrepApi.ts` — added the `updateManagedScan`, `listFindings` and
  `bulkTriage` client methods plus response helpers (`managedScanFromProject`,
  `findingIds`, `triagedCount`, `triagedIssueIds`) and a typed `managed_scan_config`
  on the project. No change to the existing project-settings methods.
- Extracted the generic canvas-parsing helpers (`canvasItems`, `normalizeName`,
  `readBool`, `strList`) into `lib/canvas.ts` — a single source of truth now shared
  by all three config types. The `projects` type re-exports them, so its handlers
  and tests are unchanged.
- Manifest registers the two new `configurationTypes` and their `app` permission
  resources; README documents both; `DATAFLOW.md` regenerated.

### Notes — how much of Semgrep is really "config-as-code"

- The **bulk of Semgrep configuration lives in the repository** as code already —
  the rules themselves (`.semgrep.yml`, `semgrep.yml`, registry ruleset references),
  which are versioned in the scanned codebase, not in the platform. This app manages
  the **platform-side** settings the public API exposes for a write: project
  settings, Managed Scans, and findings triage. It deliberately does **not** invent
  endpoints Semgrep does not document.

## 0.1.0 — 2026-08-01

### Added

- **Initial foundation** for managing Semgrep AppSec Platform configuration as
  code over the Semgrep public REST API v1. Config-as-code only — no database, no
  infrastructure provisioning.
- **Semgrep REST client** (`lib/semgrepApi.ts`): a Bearer-token client against the
  **fixed** base URL `https://semgrep.dev/api/v1`. The deployment **slug**
  (an app setting) identifies the tenant and is carried in every project path;
  it is also auto-discoverable from `GET /deployments`. Includes a connectivity
  probe, a tag-diff helper, and typed helpers for the project and deployment
  responses.
- **Project Settings** configuration type (`config-types/projects`) with the full
  handler set — validate, deploy, rollback, healthCheck, driftDetect, getStatus —
  plus a canvas covering the project name (identity), an optional primary branch,
  and a declaratively-reconciled tag set (with a per-project `manageTags` opt-out).
  - Deploy reads each project (`GET /deployments/{slug}/projects/{name}`) for a
    rollback snapshot, sets the primary branch
    (`PATCH /deployments/{slug}/projects/{name}`, field `primary_branch`), and
    reconciles tags to the declared set via the dedicated tag endpoints
    (`PUT` to add, `DELETE ?tags=…` to remove).
  - Rollback restores the prior primary branch and tag set; drift compares the
    declared primary branch + tag set against the live project.
- **Connections** page (`semgrep-deployment` component) + a `testConnection`
  handler that probes `GET /api/v1/deployments` (and, when a slug is set, checks
  the token can access it), plus **Overview** + **Setup Guide** pages.

### Notes — write surface is REAL, but there is no create-project API (be honest)

- The write path is **real and documented** (confirmed from the official OpenAPI
  spec, `https://semgrep.dev/api/v1/public_v1.openapi.yaml`): `PATCH` a project to
  set its `primary_branch`, and `PUT` / `DELETE` its tags. These are first-class
  public endpoints, not best-effort guesses.
- Semgrep exposes **no endpoint to CREATE a project** — projects are created by
  connecting a repository and running a scan. This config type therefore **updates
  the settings of projects that already exist** and never creates or deletes one
  (the same honest pattern as Snyk's project-settings type). A deploy that targets
  a non-existent project **fails with a clear message** rather than silently doing
  nothing.
- **Tag reconciliation is declarative**: the declared tag set becomes the
  project's exact tag set (missing tags added, extra tags removed). The per-project
  **Manage tags declaratively** toggle opts a project out so one authored only to
  set its primary branch never has tags removed.
- Authentication requires a **Team or Enterprise tier** Semgrep account and its API
  token; the token's scope is a single deployment (Semgrep's own API note).
