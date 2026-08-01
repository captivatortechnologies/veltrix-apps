# Semgrep (Veltrix app)

Manage **Semgrep AppSec Platform** configuration as code through the Semgrep
**public REST API v1**. Authoring happens in the Veltrix Configuration Canvas;
every write goes through the Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Semgrep API.

## What it manages

| Configuration type   | Semgrep endpoint(s)                                                                                       | Identity     | Write path |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| **Project Settings** | `PATCH /deployments/{slug}/projects/{name}` (primary branch); `PUT` / `DELETE .../{name}/tags` (tags) | Project name | **Real**   |

The Project Settings type reconciles by the project **name** (the repository as a
path, e.g. `my-org/my-repo`). Deploy reads the project for a rollback snapshot,
sets its primary branch, and reconciles its tag set to the declared set. Rollback
restores the prior primary branch and tags; drift compares the declared primary
branch and tag set against the live project.

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

| Purpose                | Method + path                                              |
| ---------------------- | ---------------------------------------------------------- |
| Connectivity / health  | `GET /deployments`                                         |
| Read a project         | `GET /deployments/{slug}/projects/{projectName}`           |
| Set the primary branch | `PATCH /deployments/{slug}/projects/{projectName}`         |
| Add tags               | `PUT /deployments/{slug}/projects/{projectName}/tags`      |
| Remove tags            | `DELETE /deployments/{slug}/projects/{projectName}/tags?tags=…` |

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
- **Managed attributes** in this foundation are the **primary branch** and the
  **tag set**. Managed-scan configuration (`managed_scan_config`, a Beta API
  surface) and other project attributes are out of scope for v0.1.0.
- **Drift is best-effort on reads.** A project that cannot be read (transient error
  or not yet scanned) is skipped rather than raising false drift.
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
