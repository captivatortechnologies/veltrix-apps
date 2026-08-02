# JFrog Xray (Veltrix app)

Manage [JFrog Xray](https://jfrog.com/xray/) (software composition analysis /
supply-chain security) configuration as code through the **Xray REST API
v2**, driven by the Veltrix Security-as-Code pipeline (validate → deploy →
health check → drift detect → rollback).

## What it manages

| Configuration type | Xray object | REST operations |
| --- | --- | --- |
| **Security Policies** (`security-policies`) | Security policies | `GET /xray/api/v2/policies` (list), `GET /xray/api/v2/policies/{name}` (read), `POST /xray/api/v2/policies` (create), `PUT /xray/api/v2/policies/{name}` (replace), `DELETE /xray/api/v2/policies/{name}` (delete) |

Reconciles by **policy name** and targets a `jfrog-xray-instance` component
(the JFrog Platform host).

### Security policies

Each policy authors **one primary rule** through typed canvas fields — a
minimum-severity gate (`All Severities` / `Critical` / `High` / `Medium` /
`Low`) or a CVSS v3 score range, plus the build/release-blocking,
notification and ticketing actions Xray supports on a rule. Two JSON escape
valves cover the long tail without gating the app on every field JFrog ships:

- `criteria_json` / `actions_json` — extra keys merged into the primary
  rule's `criteria` / `actions` (e.g. `vulnerability_ids`, `exposures`,
  `custom_severity`). The typed fields always win on a key collision.
- `additional_rules_json` — extra, fully independent rules appended after
  the primary one, for multi-tier policies (e.g. "Critical fails the build,
  High only notifies").

Xray's `PUT` has **no partial-update mode** — updating a policy always
replaces its entire rule set, so deploy always sends the full desired body
and rollback always restores the full captured prior body.

### Out of scope for 0.1.0 — Watches

A policy only takes effect once it is bound to a **Watch** (the object that
scopes a policy to specific repositories, builds, or release bundles).
Watches are a separate Xray REST object (`/xray/api/v2/watches`) with their
own reconciliation semantics and are **deferred to a follow-up release**
rather than shipped half-verified. Until then, apply a created policy to a
watch manually in the JFrog Platform UI (or via the Watches API directly).

Project-scoped policies (the `projectKey` query parameter JFrog's docs
mention on the read endpoints) are also out of scope for 0.1.0 — this
release manages **global** (tenant-wide) policies only. Whether the
create/update endpoints accept a project scope in the request body itself
was not confirmed against the official reference during this build, so it
was left out rather than guessed at.

## Authentication

A JFrog Platform **Access Token**, sent as `Authorization: Bearer <token>` —
the current, platform-recommended method. The legacy `X-JFrog-Art-Api` API
Key header reached **End of Life at the end of Q4 2024** (new API keys can
no longer even be created as of Artifactory 7.98) and is not supported.

Generate a token in **Administration → User Management → Access Tokens**,
scoped to a user or group granted the Xray **Manage Policies** and **Read
Policies** permissions, then store it as a Veltrix credential:

- **Access token** → the JFrog Platform Access Token (no username required)

## Component

Register a `jfrog-xray-instance` component whose **hostname** is your JFrog
Platform base URL — the same host used for Artifactory and Xray (e.g.
`mycompany.jfrog.io` for JFrog SaaS, or your self-hosted front door).
Requests go to `https://<host>/xray/api/v2/…`.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Xray API calls. |

## Sources consulted

- Policies (list / get / create / update / delete) — JFrog Xray REST API v2
  reference: https://jfrog.com/help/r/xray-rest-apis/get-policies,
  `/get-policy`, `/create-policy`, `/update-policy`, `/delete-policy`
  (mirrored at `docs.jfrog.com/security/reference/*_policies-v2-openapi`).
- `min_severity` value casing (`All Severities` / `Critical` / `High` /
  `Medium` / `Low`) and the full criteria/actions field set — JFrog's own
  Terraform provider docs:
  https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/security_policy.md
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
