# Changelog

All notable changes to the Semgrep app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
