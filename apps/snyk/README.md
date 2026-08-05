# Snyk

Manage **Snyk** organization configuration as code on the Veltrix Security-as-Code
platform. Author configurations in the Configuration Canvas and deploy them
through the pipeline — validation, drift detection, health checks and rollback
are handled per configuration type.

Snyk is primarily a scanner rather than a configuration platform, so its
config-as-code surface is intentionally focused. This app covers the parts of a
Snyk organization that are genuinely API-manageable, declarative and stable —
13 configuration types across Snyk's REST (JSON:API) and legacy v1 APIs.

## Coverage

Verified against Snyk's live OpenAPI specification (`GET /rest/openapi/{version}`
at `api.snyk.io`, both the `2024-10-15` and `2026-03-25` dated revisions) and the
v1 API docs, 2026-08-05.

### Managed

| Configuration type | Snyk API | Scope | Notes |
| --- | --- | --- | --- |
| **Snyk Code (SAST) Settings** | REST `GET`/`PATCH /orgs/{org}/settings/sast` | Org | Singleton toggle; GA since `2023-06-22` |
| **Secrets Settings** | REST `GET`/`PATCH /orgs/{org}/settings/secrets` | Org | Singleton toggle; **Early Access (beta)** — `x-snyk-api-stability: beta` in Snyk's spec |
| **Infrastructure as Code Settings** | REST `GET`/`PATCH /orgs/{org}/settings/iac` | Org | Singleton custom-rules bundle (OCI registry + inherit-from-parent-Group); GA since `2021-12-09` |
| **Notification Settings** | v1 `PUT /org/{org}/notification-settings` | Org | Singleton notification preferences |
| **Org Ignore Policies** | REST `/orgs/{org}/policies` | Org | Snyk Code **Consistent Ignores** only (org-level, finding-scoped); requires that feature enabled |
| **Project Ignores** | v1 `/org/{org}/project/{project}/ignore/{issueId}` | Project | Reconciled by (project id, issue id) |
| **Project Settings** | v1 `PUT`/`DELETE /org/{org}/project/{project}/settings` | Project | Pull-request test / auto-dependency-upgrade booleans; updates in place |
| **Project Attributes** | REST `GET`/`PATCH /orgs/{org}/projects/{project}` | Project | Criticality, environment, lifecycle, tags, owner, test frequency; GA since `2024-05-31`; updates in place |
| **Integration Settings** | v1 `PUT /org/{org}/integrations/{id}/settings` | Org | PR-test and auto-upgrade settings, matched by integration **type** |
| **Import Targets** | v1 `POST /org/{org}/integrations/{id}/import` | Org | Imports repositories as new projects through a configured integration; idempotent (existing targets skipped) |
| **Service Accounts** | REST `/orgs/{org}/service_accounts` | Org | The generated API token is shown **once** by Snyk and is never stored here |
| **Org Memberships** | REST `/orgs/{org}/memberships` | Org | Grants/changes/revokes an **existing** Snyk user's role; GA since `2024-08-25` |
| **Webhooks** | v1 `/org/{org}/webhooks` | Org | Reconciled by **URL**; the signing secret is **write-only** |

### Excluded (with sourced reasons)

| Surface | Snyk API | Why it's excluded |
| --- | --- | --- |
| Org-wide new-user invites | REST `/orgs/{org}/invites` | One-shot: `POST` sends an email invite that becomes a membership only on acceptance; there is nothing to read back and reconcile against, and `email`-based membership creation does not exist (`POST /memberships` requires a Snyk user id the invitee does not yet have). Grant/revoke a role for a user who **already** has a Snyk identity via **Org Memberships** above. |
| Custom role definitions | REST `/tenants/{tenant_id}/roles` | **Tenant**-scoped, one level above this app's org-scoped component (`snyk-org`); out of scope for this app rather than shipped against the wrong scope. |
| SBOM export/test | REST `/orgs/{org}/sbom_tests`, `/orgs/{org}/projects/{project}/sbom` | Read-only, one-shot report/test generation — nothing to declare or reconcile. |
| General org-level Broker config | REST `/orgs/{org}/brokers/connections` (`GET`-only at org scope); full deployment management is `/tenants/{tenant_id}/brokers/**` | Org scope is read-only; full Broker deployment/connection management is **tenant**-scoped infrastructure, not org-level security config. |
| Per-ecosystem private-registry / broker settings | REST `/orgs/{org}/settings/opensource/{ecosystem}/{broker,private-registries}` | Holds registry **credentials** (auth tokens/certs) inline in the settings payload — this is secret material embedded in a settings object, not a clean secret-vs-config split; the general `/orgs/{org}/settings/opensource` resource itself is also **read-only** (`GET` only, no `PATCH`). |
| Policy **review/approval** | REST `PATCH /orgs/{org}/policies/{id}` `attributes.review` | An approval-workflow action (`pending`/`approved`/`rejected`) performed by a human reviewer with the "Review Ignore Request" permission — not declarative desired-state config. `snyk-org-ignore-policies` never reads or writes this field. |
| Issues, dependency data, audit logs | REST `/orgs/{org}/issues`, `/ecosystems/**`, `/audit_logs/search` | Read-only reporting surfaces (the audit log **is** used internally for drift attribution, never exposed as a config type). |
| Test/monitor runs | REST `/orgs/{org}/tests`, v1 CLI-driven monitor | One-shot scan invocations, not configuration. |
| Group-level settings (`/groups/{group_id}/**`) | REST | This app's component (`snyk-org`) and `Organization ID` setting are **org**-scoped; group-level settings (SSO, group policies, group service accounts) would need a separate group-scoped component — out of scope here rather than half-wired to an org id. |

These are omitted rather than shipped half-working.

## Connecting

1. **Service-account token** — in Snyk, create a service account (Settings >
   Service accounts) with a role scoped to what this app manages and copy its API
   token.
2. **Credential** — store the token in the Veltrix credential **API token**
   field. The app sends it as `Authorization: token <token>`.
3. **Component** — register a `snyk-org` component whose hostname is your Snyk
   **region API host**:
   - `api.snyk.io` — US (default)
   - `api.eu.snyk.io` — EU
   - `api.au.snyk.io` — AU

   Snyk tokens are region-scoped, so the host must match the account's region.
4. **Organization ID** — set the `Organization ID` app setting (Snyk: Settings >
   General > Organization ID). Most Snyk configuration is org-scoped, so it is
   required for deployments.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `org_id` | — (required) | The Snyk organization ID all config types target |
| `api_version` | `2024-10-15` | Dated version for the Snyk REST API (`?version=`) |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Notes & limitations

- **Two APIs.** Snyk runs a modern REST API (JSON:API, `?version=` required) and
  a legacy v1 API in parallel; config is split across both. This app talks to
  whichever one owns each object.
- **Write-only secrets.** Webhook signing secrets are sent only on create, never
  read back, never diffed in drift detection, and never stored in rollback data
  or artifacts. Because Snyk cannot update a webhook in place, an existing URL is
  left unchanged (its secret cannot be rotated through this config type).
  Service-account tokens follow the same rule (see below).
- **Service-account tokens.** Snyk returns a service account's API token exactly
  once, at creation. This app does not capture or store that token — retrieve it
  from the deployment operator's context at create time.
- **Integration settings** apply to an integration that already exists in the
  org (identified by type, e.g. `github`, `gitlab`). Connecting an SCM to Snyk is
  done in Snyk itself; this app manages the integration's PR-test and
  dependency-upgrade behaviour.
- **Org-level ignore policies are Consistent Ignores, not general policies.**
  Snyk's `/orgs/{org}/policies` API is documented as "only available for use
  with Code Consistent Ignores" — its condition field is fixed to a Snyk Code
  finding identity (`snyk/asset/finding/v1`). It is not a general
  security-or-license policy engine; writes 403 until Code Consistent Ignores is
  enabled for the org (surfaced as Snyk's own error, not special-cased).
- **Org memberships require an existing Snyk user id.** `POST /orgs/{org}/memberships`
  takes a Snyk user UUID, not an email — there is no way to onboard a brand-new
  external user through this API (that is Snyk's invite flow, a one-shot action
  excluded above). This config type grants/changes/revokes a role for a user who
  already has a Snyk identity, and never removes a membership it did not
  declare — a deploy can never lock an operator out of their own org.
- **Infrastructure as Code settings configure a custom-rules bundle, not an
  on/off switch.** Unlike SAST/Secrets, Snyk has no simple org-level toggle for
  IaC scanning itself; `/orgs/{org}/settings/iac` configures an OCI-hosted
  custom rules bundle IaC evaluates alongside its built-in rules (or inheriting
  the parent Group's bundle instead).
- **Secrets settings are Early Access.** Snyk's OpenAPI spec tags
  `/orgs/{org}/settings/secrets` `x-snyk-api-stability: beta` — the
  request/response shape may still change in a future dated API version.
- **The org-policies REST revision is sunsetting.** Snyk's `2024-10-15` shape of
  `/orgs/{org}/policies` is deprecated in favor of `2026-03-25` and is
  sunset-eligible **2026-09-22**; the request/response shape is verified
  identical between the two, so this works today regardless of the configured
  `api_version` setting — but `snyk-org-ignore-policies` validation warns when
  that setting is still on/before `2024-10-15` so it gets bumped ahead of the
  sunset.
- **Project Attributes vs. Project Settings.** These are two independent REST
  surfaces on the same project: **Project Settings** (v1) is the pull-request
  test / auto-dependency-upgrade booleans; **Project Attributes** (REST) is
  classification metadata (criticality, environment, lifecycle, tags, owner)
  plus `test_frequency` (a scheduled re-test cadence, unrelated to the v1
  PR-test toggle). Both update an existing project in place — neither creates
  or deletes one.
- See [Coverage](#coverage) above for the full list of excluded surfaces and why.

## License

Apache-2.0
