# JFrog Xray (Veltrix app)

Manage [JFrog Xray](https://jfrog.com/xray/) (software composition analysis /
supply-chain security) configuration as code through the **Xray REST API**,
driven by the Veltrix Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

## What it manages

| Configuration type | Sidebar group | Xray object | REST operations |
| --- | --- | --- | --- |
| **Security Policies** (`security-policies`) | Policies | Policies of type `security` | `GET`/`POST /xray/api/v2/policies`, `GET`/`PUT`/`DELETE /xray/api/v2/policies/{name}` |
| **License Policies** (`license-policies`) | Policies | Policies of type `license` | Same endpoints — a policy of a different `type` |
| **Operational Risk Policies** (`operational-risk-policies`) | Policies | Policies of type `operational_risk` | Same endpoints — a policy of a different `type` |
| **Curation Policies** (`curation-policies`) | Policies | JFrog Curation policies | `GET`/`POST /xray/api/v1/curation/policies`, `GET`/`PUT`/`DELETE /xray/api/v1/curation/policies/{policy_id}` |
| **Watches** (`watches`) | Watches | Watches | `GET`/`POST /xray/api/v2/watches`, `GET`/`PUT`/`DELETE /xray/api/v2/watches/{name}` |
| **Ignore Rules** (`ignore-rules`) | Ignore Rules | Ignore rules | `GET`/`POST /xray/api/v1/ignore_rules`, `GET`/`DELETE /xray/api/v1/ignore_rules/{id}` (no update endpoint) |
| **Custom Issues** (`custom-issues`) | Data | Custom issues (vulnerabilities) | `POST`/`PUT /xray/api/v1/events`, `GET /xray/api/v2/events/{id}`, `DELETE /xray/api/v1/events/{id}` |
| **Webhooks** (`webhooks`) | Integrations | Xray webhooks | `POST /xray/api/v1/webhooks`, `GET`/`PUT`/`DELETE /xray/api/v1/webhooks/{name}` |

All eight target a `jfrog-xray-instance` component (the JFrog Platform host).

### Security, License & Operational Risk Policies

All three are policies of a different `type` (`security` / `license` /
`operational_risk`) against the **identical** `/xray/api/v2/policies` REST
surface — the CRUD-by-name plumbing and the entire **actions** schema (fail
build, block download, block release-bundle distribution/promotion, notify,
mail/webhook recipients, ticket creation) are shared between them via
`lib/xrayPolicies.ts` (confirmed policy-type-agnostic against JFrog's own
Terraform provider docs). Only the **criteria** differ:

- **Security**: a minimum-severity gate (`All Severities` / `Critical` /
  `High` / `Medium` / `Low`) or a CVSS v3 score range, plus
  `malicious_package` / `applicable_cves_only` / `fix_version_dependant`.
- **License**: `allowed_licenses` / `banned_licenses` lists, `allow_unknown`,
  and `multi_license_permissive`.
- **Operational Risk**: a named minimum risk level (High/Medium/Low), or a
  custom multi-factor rule (AND/OR) built from EOL status, release age,
  release cadence, and commit/committer activity, each with its own
  resulting risk severity.

Each policy authors **one primary rule** through typed canvas fields (the
common case), with JSON escape valves for the long tail:

- `criteria_json` / `actions_json` — extra keys merged into the primary
  rule's `criteria` / `actions`. Typed fields always win on a key collision.
- `additional_rules_json` — extra, fully independent rules appended after
  the primary one, for multi-tier policies (e.g. "Critical fails the build,
  High only notifies").

Xray's `PUT` has **no partial-update mode** — updating a policy always
replaces its entire rule set, so deploy always sends the full desired body
and rollback always restores the full captured prior body.

### Watches

A policy only takes effect once it is bound to a **Watch** — the object that
scopes a set of resources (repositories, builds, release bundles, projects,
git repositories) and assigns policies to that scope. The common case — the
whole JFrog Platform ("All repositories") or one named repository, optionally
narrowed by package-type filters — is typed; a `resources_json` escape valve
covers builds/release-bundles/projects/git-repos or multiple resources at
once. Assigned policies are referenced **by name**, split into
`security_policy_names` / `license_policy_names` tag fields (this app's own
config types, or policies created directly in Xray).

Like policies, a watch's `PUT` is a full replace, so deploy/rollback follow
the same capture-full-prior-body pattern.

### Ignore Rules

Suppress violations matching CVE/vulnerability/license/scope filters,
optionally until an expiry date. **This object behaves differently from every
other named config type here**: Xray assigns **no user-chosen name** to an
ignore rule (a server-generated UUID `id` only) and exposes **no update
endpoint** (create + delete only — confirmed against the official reference
index, which lists only create/list/get/delete pages for `ignore_rules`).

Reconciliation therefore keys off the **canvas item's own stable id**
(`item.id`, always assigned by the platform) rather than a field value —
the platform-documented pattern for a target whose server assigns an opaque
identity per item (`PlatformDataApi.getLatestDeployment` /
`DeploymentSummary.rollbackData`, see the SDK's `pipeline.ts` comment). A
declared content change **deletes the old rule and creates a new one**
instead of a PUT, since Xray offers no update path. Drift detection for this
type checks **existence only** — content structurally cannot drift, since
nothing (including a manual console edit) can mutate a rule after creation.

`notes` is required by the Xray API and doubles as this item's canvas label.

### Custom Issues

Manually-authored Xray issues (vulnerabilities) for components not covered
by Xray's own vulnerability database — e.g. an internal package, or a
vendor's own advisory feed. **Unlike every other object in this app, the
identity is a USER-CHOSEN `id`** (Xray assigns none), making reconciliation
a straightforward create-or-update-by-id: `GET /xray/api/v2/events/{id}`
decides existence, `POST /xray/api/v1/events` creates, `PUT
/xray/api/v1/events/{id}` fully replaces. Note the read endpoint is `v2`
while the write endpoints are `v1` — confirmed independently against the
official reference, not a typo.

`type` / `package_type` / `severity` are richer than a simple string in
Xray's own OpenAPI schema description, but the schema itself does **not**
enforce an enum for `type` or `package_type` (confirmed directly against the
schema, not just its prose) — so those two are offered as free text with
suggested values rather than a hard-validated dropdown; `severity` genuinely
is constrained to `Critical`/`High`/`Medium`/`Low`/`Information`.

### Webhooks

A named HTTP callback target that a security/license/operational-risk
policy's **Webhooks** action list references by name. This is Xray's **own**
webhook registry (`/xray/api/v1/webhooks`) — a **distinct object from the
JFrog Platform's separate Event/Webhooks service** that other JFrog products
share. This endpoint has no dedicated page in the official REST reference
(searching its full index for "hook" returns nothing); the schema and wire
path were instead confirmed from JFrog's own Terraform provider — the schema
from its docs, and the literal path from reading its Go source directly.

### Curation Policies

[JFrog Curation](https://docs.jfrog.com/security/docs/curation-intro)
policy-based governance that blocks (or dry-runs) risky open-source package
**versions** before they ever reach an Artifactory remote repository —
served by the Xray REST API under a `/curation` sub-path
(`/xray/api/v1/curation/policies`), which is why it stays within this app's
Xray-scoped remit even though Curation is its own JFrog product line.

Two ways this object differs from every other policy/watch/webhook here:

1. **The write URLs key off a server-assigned `policy_id`**, not the name
   directly. Deploy lists policies (which supports matching by name) to
   resolve the id, then reads/writes/deletes by id — with a defensive
   re-list fallback if a create response doesn't echo the new id directly.
2. **Update is a genuine partial update** — Xray's own docs explicitly warn
   against sending back read-only fields (`id`, `created_by`, `updated_by`,
   `created_at`, `updated_at`) from a prior GET, unlike every other
   full-replace `PUT` in this app.

`waivers` / `label_waivers` are nested, variable-length exception lists with
their own add / retain-by-id / remove-by-omission update semantics — exposed
as JSON escape valves (each entry can carry a captured `id` to be retained
across deploys).

`condition_id` is a **plain string reference** to an existing curation
condition (built-in, or a custom one created directly in Xray) — this app
does **not** manage curation condition templates or custom conditions; see
[Coverage](#coverage) below for why.

## Authentication

A JFrog Platform **Access Token**, sent as `Authorization: Bearer <token>` —
the current, platform-recommended method. The legacy `X-JFrog-Art-Api` API
Key header reached **End of Life at the end of Q4 2024** (new API keys can
no longer even be created as of Artifactory 7.98) and is not supported.

Generate a token in **Administration → User Management → Access Tokens**,
scoped to a user or group granted the Xray **Manage Policies**, **Read
Policies** and **Manage Watches** permissions (the last one covers watches,
ignore rules and custom issues — all documented as requiring it), then store
it as a Veltrix credential:

- **Access token** → the JFrog Platform Access Token (no username required)

## Component

Register a `jfrog-xray-instance` component whose **hostname** is your JFrog
Platform base URL — the same host used for Artifactory and Xray (e.g.
`mycompany.jfrog.io` for JFrog SaaS, or your self-hosted front door).
Requests go to `https://<host>/xray/api/…`.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Xray API calls. |

## Coverage

**Every entry below was inventoried from JFrog's own Terraform provider's
resource list** — `github.com/jfrog/terraform-provider-xray/tree/master/docs/resources`
(21 resources) — the most authoritative available enumeration of Xray's
genuinely declarative, idempotent config-as-code surface (a Terraform
resource is by construction create/read/update/delete-able; JFrog's own
choice of what to implement there is a strong signal of what is worth
automating). This app is intentionally **Xray-scoped**: it does not manage
Artifactory repositories or permissions, and notes below where a resource
sits right at that boundary.

### Managed (this app, v0.1.0 → v0.3.0)

| Terraform resource | This app's config type |
| --- | --- |
| `security_policy` | `security-policies` (0.1.0) |
| `license_policy` | `license-policies` (0.2.0) |
| `operational_risk_policy` | `operational-risk-policies` (0.3.0) |
| `watch` | `watches` (0.2.0) |
| `ignore_rule` | `ignore-rules` (0.2.0) |
| `custom_issue` | `custom-issues` (0.3.0) |
| `webhook` | `webhooks` (0.3.0) |
| `curation_policy` | `curation-policies` (0.3.0) |

### Intentionally excluded (with reasoning)

| Terraform resource / surface | Why it's excluded |
| --- | --- |
| `custom_curation_condition` | A separate, deeper 3-layer object (condition **templates** → **custom conditions** referencing a template + `param_values` → **policies** referencing a condition by id). Each template (EPSS, SpecificVersions, license, CVE, EOL, …) has its own `param_values` shape. Verifying every template's parameter schema responsibly was judged too large a scope for this release; `curation-policies.condition_id` instead takes a plain string so an operator can reference a condition created directly in Xray (built-in or custom) without this app half-implementing the template layer. Candidate for a future release. |
| `settings` (Xray global settings: enable/allow flags, `db_sync_updates_time`) | **Instance singleton** — one config per Xray deployment, not a named/repeatable object. Same category the coordinator called out for DB-sync scheduling; JFrog Platform mail-server configuration is the platform-wide (not Xray-specific) analog. |
| `workers_count` | **Instance singleton** — tunes the number of Xray worker processes for indexing/analysis/SBOM stages. Infrastructure sizing, not a security policy. |
| `repository_config` | Configures Xray-specific scanning/indexing/retention behavior **for an existing Artifactory repository**, referenced by `repo_name`. It does not create/delete the repo itself, but it is fundamentally *per-repository* configuration — the exact boundary this app is asked to stay out of ("don't drift into Artifactory repo/permission management"). Flagged here as a candidate for a **separate, repo-scoped app** (or a deliberate, explicitly-approved scope expansion) rather than added speculatively. |
| `binary_manager_repos` / `binary_manager_builds` / `binary_manager_release_bundles_v2` | **Binary-manager indexing** — which existing Artifactory repos/builds/release bundles Xray indexes at all. Explicitly named as excluded scope; this is inclusion/exclusion plumbing for a different subsystem (what Xray *looks at*), not a security control (what Xray *does* about what it finds). |
| `catalog_labels` | A **different JFrog product's** API — JFrog Catalog, driven by its own GraphQL service (confirmed: "requires JFrog Catalog service to be available"), not Xray's REST API. Out of this app's remit entirely; would belong to a `jfrog-catalog` app if one is ever built. |
| `exposures_report`, `licenses_report`, `operational_risks_report`, `violations_report`, `vulnerabilities_report` | **Reports are scheduled ACTIONS, not declarative state** — a report definition triggers a point-in-time (or recurring) generation job and its *output* is what matters, not a persistent resource this pipeline reconciles against. Same reasoning applies to SBOM generation, which is report-shaped. |

### Also out of scope (not in the Terraform provider, called out for completeness)

- **Vulnerability/component/artifact READ APIs** (search, details, graphs) — read-only data surfaces, not configuration.
- **Xray system settings not covered by `settings`** (e.g. proxy configuration) — instance-level, same reasoning as `settings` above.
- **Access Tokens / user & group management** — JFrog Platform-wide identity, not Xray-specific; out of this app's remit (a customer's Veltrix credential already carries the token this app uses).
- **Artifactory repository/permission management of any kind** — explicitly out of scope per this app's Xray-only remit; a natural candidate for a separate `artifactory` app.

## Sources consulted

- Policies (list / get / create / update / delete) — JFrog Xray REST API v2
  reference: https://jfrog.com/help/r/xray-rest-apis/get-policies,
  `/get-policy`, `/create-policy`, `/update-policy`, `/delete-policy`
  (mirrored at `docs.jfrog.com/security/reference/*_policies-v2-openapi`).
- `min_severity` value casing and the full security-policy criteria/actions
  field set — JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/security_policy.md
- License-policy criteria/actions — JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/license_policy.md
- Operational-risk-policy criteria — JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/operational_risk_policy.md
- Watches (list / get / create / update / delete) —
  `docs.jfrog.com/security/reference/{create-watch,get-watches,get-watch,update-watch,delete-watch}_watches-v2-openapi`.
- Watch resource field names/casing (`bin_mgr_id`, `filter.type`/`value`,
  the resource `type` enum) — JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/watch.md
- Ignore rules (list / get / create / delete — no update endpoint) —
  `docs.jfrog.com/security/reference/{create-ignore-rule,get-ignore-rules,get-ignore-rule,delete-ignore-rule}`.
  The create response's `info` message text is the only place the new id
  appears (no separate `id` field or `Location` header).
- Custom issues — `docs.jfrog.com/security/reference/{create-issue-event,get-issue-events-v2_custom-issues-v2-openapi,update-issue-event,delete-issue-event}`,
  cross-checked against JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/custom_issue.md
  (two wire-format discrepancies were found and resolved in favor of the
  literal REST example — see the 0.3.0 CHANGELOG entry).
- Webhooks — no dedicated REST reference page exists; schema from JFrog's
  own Terraform provider docs
  (https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/webhook.md)
  and the literal wire path confirmed by reading that provider's Go source
  (`resource_xray_webhook.go`).
- Curation policies — `docs.jfrog.com/security/reference/{createpolicy,listpolicies,getpolicybyid,updatepolicy,deletepolicy}`
  (confirmed by their actual `/xray/api/v1/curation/policies` request/response
  bodies — these pages share generic titles with the unrelated legacy v1
  policy API, so each was individually verified rather than assumed from its
  slug), cross-checked against JFrog's own Terraform provider docs for the
  waiver/label-waiver shapes:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/{curation_policy,custom_curation_condition}.md
- Full Xray declarative-surface enumeration used for the Coverage section —
  JFrog's own Terraform provider's resource directory listing:
  https://github.com/jfrog/terraform-provider-xray/tree/master/docs/resources
- Access Token (Bearer) authentication:
  https://docs.jfrog.com/administration/docs/access-tokens
- API Key End-of-Life notice: https://docs.jfrog.com/user-management/docs/api-key
- System ping health check (considered, not used as the connection test — see
  `handlers/testConnection.ts` for why): https://docs.jfrog.com/security/reference/ping-request

## Known limitations (by design, not oversight)

- **Project-scoped policies/watches are out of scope.** The `projectKey`
  query parameter JFrog's docs mention on read endpoints was not confirmed
  against the official reference for the WRITE endpoints, so only
  tenant-wide (global) objects are managed.
- **Ignore-rule content cannot be edited in place** — an Xray API
  constraint (no update endpoint), not a gap in this app.
- **Assigned-policy references (on a watch) are not live-validated** — a
  typo in `security_policy_names` / `license_policy_names` surfaces as an
  Xray-side deploy error rather than a validate-time one, consistent with
  how other apps in this repo handle cross-config references.
- **Curation condition templates/custom conditions are out of scope** —
  `condition_id` is a plain string reference; see Coverage above.
- **Curation policy pagination**: the list call requests up to 500 policies
  in one page; a tenant with more would need follow-up pagination support.
- **Webhook `password` may not round-trip on read** — typical secret-masking
  behavior; drift detection does not compare it, and rollback restores every
  OTHER captured field exactly.

## Development

```
cd apps/jfrog-xray
node node_modules/typescript/bin/tsc --noEmit           # typecheck
node ../../scripts/test-apps.mjs jfrog-xray              # run handler tests
node ../../scripts/validate-app.mjs apps/jfrog-xray       # validate against the app contract
```
