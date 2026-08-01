# Semgrep (Veltrix app)

Manage **Semgrep AppSec Platform** configuration as code through the Semgrep
**public REST API v1**. Authoring happens in the Veltrix Configuration Canvas;
every write goes through the Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Semgrep API.

## What it manages

| Configuration type       | Semgrep endpoint(s)                                                                                   | Identity          | Write path                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| **Project Settings**     | `PATCH /deployments/{slug}/projects/{name}` (primary branch); `PUT` / `DELETE .../{name}/tags` (tags) | Project name      | **Real**                                |
| **Managed Scan Settings** | `PATCH /deployments/{slug}/projects/{name}/managed-scan` (`full_scan` / `diff_scan`)                 | Project name      | **Real** ([Beta] surface)               |
| **Findings Triage**      | `POST /deployments/{slug}/triage` (bulk triage)                                                       | Local rule name   | **Real** (imperative — see below)       |

The **Project Settings** type reconciles by the project **name** (the repository as
a path, e.g. `my-org/my-repo`). Deploy reads the project for a rollback snapshot,
sets its primary branch, and reconciles its tag set to the declared set. Rollback
restores the prior primary branch and tags; drift compares the declared primary
branch and tag set against the live project.

The **Managed Scan Settings** type toggles Semgrep **Managed Scans** (Semgrep-hosted
scanning) — weekly full scans and diff-aware (PR) scans — for an existing project.
Deploy snapshots the project's `managed_scan_config`, then `PATCH`es the declared
state; rollback restores the prior flags; drift compares declared vs live. This is a
clean, fully-reconciled type — but Managed Scans is a **`[Beta]`** Semgrep surface
and only applies to projects **onboarded to Managed Scanning**.

The **Findings Triage** type is **imperative, not declarative** — Semgrep has **no
triage-rule object**, only a bulk-triage *action*. Each item is a named rule (a
finding selection + a desired triage state); deploy applies it via `POST /triage` to
the findings matching **right now**. Because findings are a moving target, **drift is
best-effort** (it re-queries `GET /findings` for still-un-triaged matches) and
**rollback is best-effort** (it re-triages the exact finding ids this deploy changed
back to `reopened`). A narrowing filter (repositories, rules, or severities) is
**required** so a rule can never triage an entire deployment.

> **Semgrep's config-as-code is mostly repo-side.** The bulk of Semgrep
> configuration — the **rules** themselves (`.semgrep.yml`, registry ruleset
> references) — lives versioned in the scanned repository, not in the platform. This
> app manages the platform-side settings the public API exposes for a write; it does
> not invent endpoints Semgrep does not document.

> **The write surface is real — but there is no create-project API.** Semgrep's
> public API (confirmed from the official OpenAPI spec,
> `https://semgrep.dev/api/v1/public_v1.openapi.yaml`) documents first-class writes
> to a project's `primary_branch` (`PATCH`) and its tags (`PUT` / `DELETE`). It
> exposes **no endpoint to create a project** — projects are created by connecting
> a repository and running a scan. This app therefore **updates the settings of
> projects that already exist** and never creates or deletes one (the same honest
> pattern as Snyk's project-settings type). A deploy that targets a project which
> does not exist **fails with a clear message**.

## API & authentication

Semgrep exposes **one hosted** REST API with a **fixed** base URL:
`https://semgrep.dev/api/v1`. There is no region or tenant host — the deployment
**slug** identifies the tenant and is carried in every project path.

- **Transport:** plain JSON over HTTPS. Standard REST verbs (`GET` read, `PATCH`
  update project, `PUT` / `DELETE` for tags).
- **Auth:** a single Semgrep API token sent as a Bearer header on every call —
  `Authorization: Bearer <token>`. The token is provisioned in the Semgrep AppSec
  Platform under **Settings > Tokens** and requires a **Team or Enterprise tier**
  account. Its scope is a single deployment.
- **Deployment slug:** set the app's **Deployment Slug** setting. It is also
  auto-discoverable — `GET /deployments` returns the single deployment the token
  can access.
- **Bad credentials** surface as **HTTP 401 / 403**.

### Endpoints used

| Purpose                    | Method + path                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| Connectivity / health      | `GET /deployments`                                                  |
| Read a project             | `GET /deployments/{slug}/projects/{projectName}`                    |
| Set the primary branch     | `PATCH /deployments/{slug}/projects/{projectName}`                  |
| Add tags                   | `PUT /deployments/{slug}/projects/{projectName}/tags`               |
| Remove tags                | `DELETE /deployments/{slug}/projects/{projectName}/tags?tags=…`     |
| Toggle Managed Scans       | `PATCH /deployments/{slug}/projects/{projectName}/managed-scan`     |
| Bulk-triage findings       | `POST /deployments/{slug}/triage`                                   |
| List findings (triage drift) | `GET /deployments/{slug}/findings`                                |

## Setup

1. **API token** — in the Semgrep AppSec Platform, **Settings > Tokens**, create
   an API token (Team/Enterprise tier).
2. **Credential** — store the token as a Veltrix credential in the token field on
   the Connections page.
3. **Component** — saving a connection registers a **`semgrep-deployment`**
   component. The base URL is fixed, so leave the endpoint as `semgrep.dev`.
4. **Deployment slug** — set the app's **Deployment Slug** setting (find it at
   `GET /api/v1/deployments` or in the Semgrep Settings).
5. **Connections** — use the app's Connections page to verify the token with a
   live probe (`GET /api/v1/deployments`); when a slug is set, it also checks the
   token can access that deployment.

## Configuration notes

- **Project name** is the identity — the repository as a path, e.g.
  `my-org/my-repo`. It must match a project that already exists in Semgrep.
- **Primary branch** maps to the API field `primary_branch`. Use a full ref such
  as `refs/heads/main`, or `None` to always follow the SCM default branch. Leave it
  blank to leave the primary branch **unmanaged** (deploy sends nothing and drift
  does not assert it).
- **Tags** are reconciled **declaratively** when **Manage tags declaratively** is
  on: the declared set becomes the project's exact tag set (missing tags are added
  via `PUT`, extra tags are removed via `DELETE`; Semgrep creates any tag that does
  not yet exist in the deployment). Turn the toggle **off** to leave a project's
  tags untouched — useful when an item exists only to set the primary branch.

## Limitations

- **Updates existing projects only.** Semgrep has no create-project API, so a
  project must already exist (created by connecting a repo and scanning). Deploying
  to a missing project fails rather than silently doing nothing.
- **Managed Scans is a `[Beta]` surface** and applies only to projects onboarded to
  Semgrep Managed Scanning; a project that is not onboarded fails the deploy with a
  clear message.
- **Triage is imperative, not declarative.** There is no server-side triage-rule
  object — deploy applies the rule to the findings matching at that moment. Findings
  are a moving target, so re-deploy re-applies; **drift and rollback are
  best-effort** (drift re-queries `GET /findings`; rollback re-opens the exact
  finding ids the deploy changed). A narrowing filter is required so a rule can never
  triage a whole deployment.
- **Drift is best-effort on reads.** A project (or finding set) that cannot be read
  is skipped rather than raising false drift.
- Write-only secrets (the API token) are never read back, diffed, or stored in
  rollback data / artifacts / logs.
- The app writes only through the Semgrep API; it registers no platform-side
  database tables or background jobs.

## Development

```
cd apps/semgrep
node node_modules/typescript/bin/tsc --noEmit        # typecheck
node ../../scripts/test-apps.mjs semgrep             # run the config-type tests
node ../../scripts/validate-app.mjs apps/semgrep      # (from repo root) manifest + bundle checks
```
