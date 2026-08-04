# Semgrep (Veltrix app)

Manage **Semgrep AppSec Platform** configuration as code through the Semgrep
**public REST API v1** and the **Policies V2 `[Beta]`** API. Authoring happens in
the Veltrix Configuration Canvas; every write goes through the Security-as-Code
pipeline (validate → deploy → health check → drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Semgrep API.

## What it manages

| Configuration type       | Semgrep endpoint(s)                                                                                   | Identity          | Write path                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| **Project Settings**     | `PATCH /deployments/{slug}/projects/{name}` (primary branch); `PUT` / `DELETE .../{name}/tags` (tags) | Project name      | **Real**                                |
| **Managed Scan Settings** | `PATCH /deployments/{slug}/projects/{name}/managed-scan` (`full_scan` / `diff_scan`)                 | Project name      | **Real** ([Beta] surface)               |
| **Findings Triage**      | `POST /deployments/{slug}/triage` (bulk triage)                                                       | Local rule name   | **Real** (imperative — see below)       |
| **Detection Policy**     | `GET` / `PUT /api/policies/v2/deployments/{id}/detection-policy/{product}` (+ `:dryRun`)               | Product (code/secrets) | **Real** ([Beta] Policies V2)      |
| **Remediation Policies** | `GET` / `PUT /api/policies/v2/deployments/{id}/remediation-policies` (+ `:dryRun`)                     | Policy slug       | **Real** ([Beta] Policies V2)           |

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

The **Detection Policy** type declares the deployment-wide rule **selection** for
Semgrep Code (SAST) or Semgrep Secrets — registry rulesets, individually added
rules, explicitly disabled rules, and per-project/tag include/exclude
**exceptions** — one item per product. It is applied over the **Policies V2
`[Beta]`** API, which **replaces the deprecated v1 Policies API**
(`PUT .../policies/{id}` is `deprecated: true` in the v1 spec). Deploy reads the
product's bundle + `state_version`, then strictly applies the declared bundle
under an `If-Match: state_version` header — a genuinely optimistic-concurrency,
whole-bundle **replace** (exceptions absent from it are deleted), not a
best-effort PATCH. Validate additionally runs Semgrep's own **dry-run preview**
(`POST .../detection-policy/{product}:dryRun`) live against the target when a
connection is available, surfacing the API's own validation errors before
deploy. A product not yet **enabled** for the deployment fails with a clear
message rather than silently doing nothing.

The **Remediation Policies** type declares the deployment's **whole** bundle of
named policies — conditions (severity, confidence, repository tag, …) that fire
actions (`block`, `pr_comment`, `jira`, `slack_app`, `webhook`, `triage`) when a
finding matches. It is applied the same way as Detection Policy: a strict,
optimistically-concurrent `PUT` that replaces the entire declared list (a policy
absent from it is deleted; **system-managed policies are excluded and
unaffected**), with the same live dry-run preview at validate time. Some action
types have companion requirements (e.g. `block` requires `pr_comment` in the same
policy) — enforced by Semgrep's own validator via the dry-run, not duplicated
here. A slug colliding with a system-managed policy fails with `RESERVED_SLUG`.

> **Semgrep's config-as-code is still mostly repo-side.** The rule **content**
> itself (`.semgrep.yml`, custom rule bodies) lives versioned in the scanned
> repository — there is no API to upload custom rule content. What the public API
> now exposes for a write is the platform-side **selection and policy** layer on
> top of that content: which rulesets/rules run, explicit exceptions, and
> condition-matched remediation actions (Detection Policy + Remediation
> Policies), plus project settings, Managed Scans, and triage. This app manages
> exactly that surface; it does not invent endpoints Semgrep does not document.

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

Semgrep exposes **two** hosted REST APIs on the same host, both reached with the
same Bearer token:

- **v1** — **fixed** base URL `https://semgrep.dev/api/v1`. No region or tenant
  host — the deployment **slug** identifies the tenant and is carried in every
  project path.
- **Policies V2 `[Beta]`** — `https://semgrep.dev/api/policies/v2/...`, documented
  at `https://docs.semgrep.dev/api-reference/v2/`. Keyed by the **numeric**
  deployment id (not the slug) — this app resolves it from the same
  `GET /deployments` call that discovers the slug. Every write is a **strict,
  optimistically-concurrent** whole-bundle replace guarded by an
  `If-Match: state_version` header (`428` if missing, `409` with the current
  version if stale — this app re-reads and retries exactly once), with a
  `:dryRun` endpoint that validates + diffs a candidate bundle without writing.

- **Transport:** plain JSON over HTTPS. Standard REST verbs (`GET` read, `PATCH`
  update project, `PUT` for tags / Managed Scans / Policies V2 applies, `DELETE`
  for tags).
- **Auth:** a single Semgrep API token sent as a Bearer header on every call —
  `Authorization: Bearer <token>`. The token is provisioned in the Semgrep AppSec
  Platform under **Settings > Tokens** and requires a **Team or Enterprise tier**
  account. Its scope is a single deployment.
- **Deployment slug / id:** set the app's **Deployment Slug** setting. It is also
  auto-discoverable — `GET /deployments` returns the single deployment the token
  can access, along with its numeric id (used by Policies V2).
- **Bad credentials** surface as **HTTP 401 / 403**.

### Endpoints used

| Purpose                        | Method + path                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| Connectivity / health / slug+id resolution | `GET /deployments`                                              |
| Read a project                  | `GET /deployments/{slug}/projects/{projectName}`                         |
| Set the primary branch          | `PATCH /deployments/{slug}/projects/{projectName}`                       |
| Add tags                        | `PUT /deployments/{slug}/projects/{projectName}/tags`                    |
| Remove tags                     | `DELETE /deployments/{slug}/projects/{projectName}/tags?tags=…`          |
| Toggle Managed Scans            | `PATCH /deployments/{slug}/projects/{projectName}/managed-scan`          |
| Bulk-triage findings            | `POST /deployments/{slug}/triage`                                        |
| List findings (triage drift)    | `GET /deployments/{slug}/findings`                                       |
| Read / apply a detection policy | `GET` / `PUT /api/policies/v2/deployments/{id}/detection-policy/{product}` |
| Preview a detection policy apply | `POST /api/policies/v2/deployments/{id}/detection-policy/{product}:dryRun` |
| Read / apply remediation policies | `GET` / `PUT /api/policies/v2/deployments/{id}/remediation-policies`   |
| Preview a remediation policies apply | `POST /api/policies/v2/deployments/{id}/remediation-policies:dryRun` |

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
- **Detection Policy exceptions**, **remediation policy conditions**, and
  **remediation policy actions** are each a JSON array authored in a textarea, in
  the *exact* wire shape Semgrep's API uses (snake_case field names like
  `exception_type` / `project_tag_name`) — so the JSON you write matches what
  Semgrep's own docs and dry-run validation errors reference. Structural shape is
  checked in `validate.ts`; accepted condition/action **values** and companion
  requirements (e.g. `block` requires `pr_comment`) are enforced **live**, via a
  dry-run preview against the target when a connection is available — discover
  them yourself at any time via `GET .../vocab?product=remediation`.
- **Remediation policy identity is the slug**, always explicit. The raw API lets
  `slug` be server-derived from `name` on create; this app requires it so canvas
  identity never silently shifts when a policy is renamed.

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
- **Detection Policy and Remediation Policies are `[Beta]` Policies V2 surfaces**
  (each response is explicitly badged `Beta` in Semgrep's own API docs). A
  Detection Policy item requires the targeted product (**code** or **secrets**)
  to already be **enabled** for the deployment; deploy fails with a clear message
  otherwise (404 `PRODUCT_NOT_ENABLED`). A Remediation Policies slug that
  collides with a **system-managed** policy fails with `RESERVED_SLUG`.
- **Remediation Policies is a whole-list reconcile** — the declared item set
  becomes the deployment's exact policy list; a policy removed from the canvas is
  **deleted** on the next deploy (system-managed policies are excluded and never
  affected). `validate.ts` requires at least one item so an accidentally emptied
  canvas is rejected outright rather than silently wiping every policy.
- **Drift is best-effort on reads.** A project, product bundle, or finding set
  that cannot be read is skipped rather than raising false drift.
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

## Coverage (v0.3.0)

Coverage was re-audited from scratch against **both** of Semgrep's OpenAPI
specs — the public v1 spec (`https://semgrep.dev/api/v1/public_v1.openapi.yaml`)
and the v2 spec (`https://semgrep.dev/api/v2/openapi.yaml`, documented at
`https://docs.semgrep.dev/api-reference/v2/`) — on 2026-08-04, classifying every
operation in both by HTTP method, maturity badge (`Stable` / `Beta` /
`Experimental`), deprecation flag, and — critically — its `security` scheme:
only operations that accept `SemgrepWebToken` (the Bearer **API token** this app
authenticates with) are reachable at all; operations whose only scheme is
`SemgrepJWT` (a logged-in user's browser-session token) are **not**, regardless
of how declarative their surface looks.

### Managed declarative configuration (v1 + Policies V2)

| Configuration type    | Endpoint(s)                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Project Settings       | `PATCH /deployments/{slug}/projects/{name}`; `PUT` / `DELETE .../{name}/tags`         |
| Managed Scan Settings  | `PATCH /deployments/{slug}/projects/{name}/managed-scan`                              |
| Findings Triage        | `POST /deployments/{slug}/triage` (imperative — no triage-rule resource)              |
| Detection Policy       | `GET` / `PUT /api/policies/v2/deployments/{id}/detection-policy/{product}` (+ dryRun) |
| Remediation Policies   | `GET` / `PUT /api/policies/v2/deployments/{id}/remediation-policies` (+ dryRun)       |

Detection Policy and Remediation Policies (`PoliciesV2Service`, `[Beta]`) are
**the current, non-deprecated replacement** for the v1 Policies API
(`GET`/`PUT /deployments/{deploymentId}/policies...`, tag `PoliciesService`) —
every operation in that v1 service is marked `deprecated: true` in the spec and
its own description says *"Use the Policies V2 API instead… this service stops
working after the migration."* This app therefore builds on Policies V2, not the
deprecated v1 surface (superseding the 0.2.0 CHANGELOG note that rejected
`PUT .../policies/{id}` — that verdict was correct for v1, but the migration
target existed all along and is now built).

### Intentionally excluded

- **`IgnoresService`** (`GET`/`POST`/`DELETE`/`PATCH /api/agent/deployments/{id}/ignores`)
  — despite the name matching "ignores/triage-as-config" almost exactly, every
  operation's `security` is **`SemgrepJWT` only** (no `SemgrepWebToken`). This
  surface is reachable **only from a logged-in browser session**, never from an
  API token — it is not a gap in this app, it is not reachable by any API-token
  integration at all.
- **`/api/agent/...`, `/api/scm/...`, `/api/sca/...` (list/search/dependency
  endpoints), `RuleboardService`, notification webhooks/automations, Wiz/Jira/
  Slack integration config, SCM app installs, package-manager auth configs,
  onboarding checklists, AI "memories"/autotriage feedback, review-comment
  content, and the internal `/api/agent/deployments/{id}/managed_scan_settings`
  service** — every one of these is marked **`Experimental`** in the v2 spec
  (*"not originally designed for third-party use… expect significant breaking
  changes"*) or carries **no maturity badge and no description at all**
  (`managed_scan_settings`, distinct from — and undocumented next to — the
  `[Beta]`, documented v1 Managed Scan Settings this app already builds on).
  Building a production config-as-code type on an endpoint Semgrep itself
  labels "not for third-party use" fails this app's reliability bar; each is
  logged here rather than silently skipped.
- **RBAC Teams** (`/api/permissions/v2/deployments/{id}/teams...`, `[Beta]`,
  reachable with an API token) — genuinely usable, but it manages **who can
  access Semgrep** (org membership, repo/role grants), not AppSec scanning
  configuration. Out of scope for the same reason Cisco Meraki excludes
  organization-wide administrators: it sits outside this app's
  `semgrep-deployment` connection boundary. A candidate for a future,
  identity-focused release if ever warranted.
- **v1 `PoliciesService`** (`GET`/`PUT /deployments/{deploymentId}/policies...`)
  — every operation is `deprecated: true` in the v1 spec (see above); superseded
  by Policies V2.
- **Custom rule / ruleset upload** — searched both specs end-to-end; there is
  **no endpoint** to upload custom rule content. Registry ruleset/rule
  **references** (`p/owasp-top-10`, `python.lang.security.audit.…`) are
  declarative inputs to Detection Policy, but the rule **content** itself is
  authored and versioned in the scanned repository or the Semgrep Registry, not
  pushed through this API.
- **Findings, dependencies, scans, secrets, SBOM export, tickets/ticketing,
  reporting (`/api/reporting/...`), and other list/search/export endpoints** are
  read-only (or produce an artifact/side-effect, e.g. SBOM export, autofix PR
  creation) — not durable desired state a canvas can own.
- **Deployment creation/update** (`POST`/`PATCH /api/agent/deployments...`) is
  tenant bootstrap, not per-tool configuration, and is `Experimental`.

Primary references: the v1 spec (`https://semgrep.dev/api/v1/public_v1.openapi.yaml`,
linked from `https://semgrep.dev/api/v1/docs`), the v2 spec
(`https://semgrep.dev/api/v2/openapi.yaml`, linked from
`https://docs.semgrep.dev/api-reference/v2/`), and each endpoint referenced in
`lib/semgrepApi.ts`.
