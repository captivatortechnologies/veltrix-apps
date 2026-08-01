# Changelog

All notable changes to the Semgrep app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
