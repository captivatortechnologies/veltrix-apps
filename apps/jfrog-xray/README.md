# JFrog Xray (Veltrix app)

Manage [JFrog Xray](https://jfrog.com/xray/) (software composition analysis /
supply-chain security) configuration as code through the **Xray REST API**,
driven by the Veltrix Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

## What it manages

| Configuration type | Xray object | REST operations |
| --- | --- | --- |
| **Security Policies** (`security-policies`) | Policies of type `security` | `GET`/`POST /xray/api/v2/policies`, `GET`/`PUT`/`DELETE /xray/api/v2/policies/{name}` |
| **License Policies** (`license-policies`) | Policies of type `license` | Same endpoints as Security Policies — a policy of a different `type` |
| **Watches** (`watches`) | Watches | `GET`/`POST /xray/api/v2/watches`, `GET`/`PUT`/`DELETE /xray/api/v2/watches/{name}` |
| **Ignore Rules** (`ignore-rules`) | Ignore rules | `GET`/`POST /xray/api/v1/ignore_rules`, `GET`/`DELETE /xray/api/v1/ignore_rules/{id}` (no update endpoint) |

All four target a `jfrog-xray-instance` component (the JFrog Platform host).

### Security policies & License policies

Both are policies of a different `type` (`security` vs `license`) against the
**identical** `/xray/api/v2/policies` REST surface — the CRUD-by-name
plumbing and the entire **actions** schema (fail build, block download,
block release-bundle distribution/promotion, notify, mail/webhook
recipients, ticket creation) are shared between them via `lib/xrayPolicies.ts`
(confirmed policy-type-agnostic against JFrog's own Terraform provider docs).
Only the **criteria** differ:

- **Security**: a minimum-severity gate (`All Severities` / `Critical` /
  `High` / `Medium` / `Low`) or a CVSS v3 score range, plus
  `malicious_package` / `applicable_cves_only` / `fix_version_dependant`.
- **License**: `allowed_licenses` / `banned_licenses` lists, `allow_unknown`,
  and `multi_license_permissive`.

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

### Ignore rules

Suppress violations matching CVE/vulnerability/license/scope filters,
optionally until an expiry date. **This object behaves differently from every
other config type here**: Xray assigns **no user-chosen name** to an ignore
rule (a server-generated UUID `id` only) and exposes **no update endpoint**
(create + delete only — confirmed against the official reference index, which
lists only create/list/get/delete pages for `ignore_rules`).

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

## Authentication

A JFrog Platform **Access Token**, sent as `Authorization: Bearer <token>` —
the current, platform-recommended method. The legacy `X-JFrog-Art-Api` API
Key header reached **End of Life at the end of Q4 2024** (new API keys can
no longer even be created as of Artifactory 7.98) and is not supported.

Generate a token in **Administration → User Management → Access Tokens**,
scoped to a user or group granted the Xray **Manage Policies** and **Read
Policies** permissions (also **Manage Watches** for the watches and
ignore-rules config types), then store it as a Veltrix credential:

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
- Watches (list / get / create / update / delete) —
  `docs.jfrog.com/security/reference/{create-watch,get-watches,get-watch,update-watch,delete-watch}_watches-v2-openapi`.
- Watch resource field names/casing (`bin_mgr_id`, `filter.type`/`value`,
  the resource `type` enum) — JFrog's own Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/watch.md
- Ignore rules (list / get / create / delete — no update endpoint) —
  `docs.jfrog.com/security/reference/{create-ignore-rule,get-ignore-rules,get-ignore-rule,delete-ignore-rule}`.
  The create response's `info` message text is the only place the new id
  appears (no separate `id` field or `Location` header).
- Access Token (Bearer) authentication:
  https://docs.jfrog.com/administration/docs/access-tokens
- API Key End-of-Life notice: https://docs.jfrog.com/user-management/docs/api-key
- System ping health check (considered, not used as the connection test — see
  `handlers/testConnection.ts` for why): https://docs.jfrog.com/security/reference/ping-request

## Development

```
cd apps/jfrog-xray
node node_modules/typescript/bin/tsc --noEmit           # typecheck
node ../../scripts/test-apps.mjs jfrog-xray              # run handler tests
node ../../scripts/validate-app.mjs apps/jfrog-xray       # validate against the app contract
```
