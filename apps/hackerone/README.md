# HackerOne

Manage HackerOne program **scope, policy and organization asset inventory** as
code. This app authors a program's **Structured Scopes**, **Credential
Inquiries**, **Scope Exclusions** and **Policy** text, and an organization's
**Asset** inventory plus its **Asset Scope** attachments to programs — and
drives all of them through the Veltrix Security-as-Code pipeline (validate,
deploy, health check, drift detection and rollback).

- **Category:** COMPLIANCE
- **API:** `https://api.hackerone.com/v1` (fixed host), JSON:API
- **Auth:** HTTP Basic — `Authorization: Basic base64(<API username>:<API token>)`
- **No BYOL / no database** — HackerOne is a pure SaaS API.

## What it manages

| Configuration type | HackerOne object | Identity | API operations | Required permission |
| --- | --- | --- | --- | --- |
| **Structured Scopes** (`structured-scopes`) | Program asset scope (legacy, program-level) | `asset_identifier`, per program | `GET`/`POST`/`PUT` `/programs/{id}/structured_scopes[/{id}]` | unstated — write path FLAGGED, see below |
| **Credential Inquiries** (`credential-inquiries`) | Per-scope researcher credential request | `asset_identifier`, per program | `GET/POST/PUT/DELETE /programs/{id}/credential_inquiries[/{id}]` | Team Management |
| **Program Policy** (`program-policy`) | Program disclosure / bounty policy text | `program_handle` (singleton per program) | `GET /programs/{id}`, `PUT /programs/{id}/policy` | Program Management |
| **Scope Exclusions** (`scope-exclusions`) | Named report category excluded from scope/reward | `category`, per program | `GET/POST /programs/{id}/scope_exclusions`, `PUT/DELETE .../scope_exclusions/{id}` | Program Management |
| **Assets** (`assets`) | Organization asset inventory record | `identifier`, per organization | `GET/POST /organizations/{id}/assets`, `PUT .../assets/{id}`, `POST .../assets/archive` (bulk) | unstated — see Flagged |
| **Asset Scopes** (`asset-scopes`) | Asset-to-program scope attachment | `asset_identifier`, per organization+program | `POST .../assets/{id}/scopes`, `PUT .../scopes/{id}`, `POST .../scopes/archive` (bulk) | unstated — see Flagged |

### Structured Scopes — the legacy, program-level write path

One item = one asset in a program's scope, addressed directly against the
program (not the organization). Fields: `program_handle`, `asset_identifier`,
`asset_type`, `eligible_for_submission`, `eligible_for_bounty`, `max_severity`,
`instruction`. Scopes are grouped by `program_handle`, each handle resolved to
its program id, and each asset **upserted by identifier** within that program.
`rollback` restores the prior attributes of a scope it updated, or archives a
scope it created.

**This write path is flagged.** HackerOne removed the program-level create /
update / archive structured-scope endpoints from its public docs on
**2026-04-07** — assets are now managed via the **organization asset
management** endpoints instead (see **Assets** + **Asset Scopes** below, added
in 0.3.0 as the confirmed replacement). The `GET` (list) endpoint remains
documented and is still used by `structured-scopes`' own drift/reconciliation
*and* reused by `asset-scopes` to read existing attachments. This config type is
kept for backward compatibility with existing deployments; new work should
prefer **Assets** + **Asset Scopes**.

### Credential Inquiries — per scope, non-secret

One item = one program's request, attached to a structured scope, for the
information a researcher must provide before the program issues test
credentials for that asset. Its only writable attribute is `description`. A
program keeps at most one inquiry per scope, so inquiries are **upserted by the
scope they attach to** (resolved via the program's still-documented scope
listing). Requires the **Team Management** permission on the API token.

### Program Policy — the program's whole disclosure document

One item = one program's entire policy text (Markdown), replaced wholesale —
there is no partial/append update. `rollback` restores the exact text captured
immediately before the deploy overwrote it (`GET /programs/{id}` first, then
`PUT /programs/{id}/policy`). There is no create/delete concept: a program
always has *some* policy text, so this config type only ever updates.

### Scope Exclusions — named categories with a genuine DELETE

One item = one named report category excluded from a program's scope /
rewards (e.g. "Denial of Service", "Social Engineering"), in addition to its
core ineligible findings. Reconciled by **`category`** (case-insensitive)
within a program — the only caller-visible identity HackerOne exposes.
Unlike Structured Scopes, this resource has a genuine `DELETE` endpoint, so
`rollback` of a created exclusion is an unambiguous delete rather than an
archive-vs-delete guess.

### Assets — the organization asset inventory (the modern replacement)

One item = one asset in an **organization's** inventory (not yet attached to
any program). This is the confirmed, non-deprecated successor to the
program-level structured-scope create/update endpoints. Fields: `identifier`
(immutable), `asset_type` (immutable; an 18-value enum **distinct** from the
legacy Structured Scopes enum — camelCase, e.g. `androidPlayStore`, vs. the
legacy `GOOGLE_PLAY_APP_ID`), `description`, `max_severity`,
`confidentiality_requirement` / `integrity_requirement` /
`availability_requirement` (CVSS environmental CIA modifiers — **no
"critical"** value, unlike `max_severity`), `reference`. Upserted by
`identifier` via the `filter[identifier]` query (avoids paginating an entire
organization's asset list, which HackerOne caps at 10,000 rows via offset
pagination). `max_severity` now lives **on the asset**, shared across every
program it is later scoped to — a real semantic change from the legacy model,
where severity was set per (program, scope) pair.

HackerOne exposes no per-id `DELETE` for assets — only a **bulk** archive
endpoint (`POST /organizations/{id}/assets/archive`) — so `rollback` of a
created asset calls it with a single-element id array.

### Asset Scopes — attaching an organization asset to a program

One item = one (organization, program, asset) attachment: eligibility for
submission/bounty, tester instruction, researcher notification. The asset must
already exist as an organization asset (create it with **Assets** first). The
write path is new (`POST/PUT/POST .../assets/{id}/scopes[.../archive]`), but
the **read** path reuses the still-documented
`GET /programs/{id}/structured_scopes` — the live resource returned is still
`type: structured-scope`. HackerOne's own docs name the "notify subscribers"
boolean **differently** on create vs. update (`notify_subscribers_on_changes`
vs. `notify_subscribers_of_changes`) — both are sent verbatim, per operation
(flagged below). There is no per-scope-id delete; the bulk archive endpoint is
keyed by **program** id, not scope id.

## Connecting

1. In HackerOne, create an **API token** (Organization Settings → API Tokens).
   HackerOne shows an **identifier** (the token name) and a **token value**.
2. On the app's **Connections** page, store the identifier in **API username** and
   the token value in **API token**. The API host is fixed at `api.hackerone.com`.
3. **Test** the connection — it calls `GET /me/programs`.
4. Author configuration in the **Configuration Canvas** and deploy through the pipeline.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for HackerOne API calls. |

## Development

```
cd apps/hackerone
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs hackerone             # run handler tests
node ../../scripts/validate-app.mjs apps/hackerone     # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against the HackerOne Customer API resource index and
customer reference (schema) pages (`https://api.hackerone.com/customer-resources/`,
`https://api.hackerone.com/customer-reference/`), verified directly against the
raw published HTML on **2026-08-04** rather than search-result summaries, which
proved to have inaccurate endpoint paths in a few places (corrected here).

### Managed declarative configuration

| Configuration type | HackerOne API operations |
| --- | --- |
| Structured Scopes (legacy) | `GET`/`POST`/`PUT` `/programs/{id}/structured_scopes[/{id}]` |
| Credential Inquiries | `GET/POST/PUT/DELETE /programs/{id}/credential_inquiries[/{id}]` |
| Program Policy | `GET /programs/{id}`, `PUT /programs/{id}/policy` |
| Scope Exclusions | `GET/POST /programs/{id}/scope_exclusions`, `PUT/DELETE .../scope_exclusions/{id}` |
| Assets (org inventory) | `GET/POST /organizations/{id}/assets`, `PUT .../assets/{id}`, `POST .../assets/archive` |
| Asset Scopes (org attachment) | `POST .../assets/{id}/scopes`, `PUT .../scopes/{id}`, `POST .../scopes/archive` |

### Considered and deliberately declined (not padding — see CHANGELOG 0.3.0 for detail)

- **Weakness / CWE program config** — `GET /programs/{id}/weaknesses` is
  read-only; the only write, `PUT /reports/{id}/weakness`, sets a specific
  **report's** weakness, not program-level CWE configuration.
- **Custom Field Attributes** (field *definitions*) — confirmed **UI-only**
  (HackerOne Help Center); the API only references an existing attribute's id
  when setting a report's custom field *values*.
- **Inbox / Triage rules** — no such resource exists; `GET
  /organizations/{id}/inboxes` is the only, read-only, inbox endpoint.
- **Automations** (the "triggers" candidate) — fully writable
  (`GET/POST/PATCH /organizations/{id}/automations`), but `code` is arbitrary
  **Node.js 20 JavaScript** executed by a service account holding **all**
  organization/engagement/asset permissions. Declined for the same reason
  Credentials was declined in 0.2.0 (secrets in canvas config): storing and
  auto-running org-privileged arbitrary code is the wrong shape for declarative
  config. Candidate for a future, dedicated, security-reviewed design.
- **Organization Groups / member roles** (RBAC) — `POST/PUT
  /organizations/{id}/groups` (`organization-member-group`) is writable, but
  this is org-wide identity/access-control administration — a distinct
  security-admin surface this app's program-scope/asset-inventory boundary
  does not own (the same reasoning that keeps RBAC a dedicated IDP-app concern
  elsewhere in this platform).
- **Campaigns** — writable, but a time-boxed, financially-consequential
  workflow (real bounty-pool payouts) with an explicit non-idempotent
  `Launch`/`End` action — does not fit the idempotent upsert + safe-rollback
  shape this pipeline assumes.
- **Findings Workboards / Views** (ASM saved searches) — full CRUD, but a
  saved-search/dashboard-layout convenience in the separate Attack Surface
  Management subsystem, not security-relevant declarative state.
- **Organization asset-management read-only surface** — asset tags/categories,
  asset ports, reachability, screenshots, CSV import and attachments are
  read/action endpoints (or, for CSV import, a bulk imperative action), not
  plain declarative fields; not modeled as a config type.
- Reports, Bounties/Swag, Hacker Invitations, Messages, Triage Reviews, CVE
  Requests, Analytics/Activities, Organization Members/Invitations and Users
  are imperative actions or read-only reference data, not durable program/asset
  configuration.

### Flagged for verification against live HackerOne

- **Structured Scopes write path** — see the dedicated note above; the
  program-level write endpoints were removed from HackerOne's docs on
  2026-04-07. Prefer **Assets** + **Asset Scopes** for new work.
- **Assets / Asset Scopes required permission** — unlike every other resource
  in HackerOne's published reference, these endpoints state no "Required
  permissions" line. Verify the actual token scope against a live organization.
- **`notify_subscribers_on_changes` vs. `notify_subscribers_of_changes`** — a
  documented key-name inconsistency between Asset Scopes' create and update
  bodies; both are sent verbatim, per operation, unverified against a live
  program.
- The exact `asset_type` machine enum sets (both the legacy Structured Scopes
  enum and the new Assets enum) have varied across API revisions — verify the
  canvas select values if a type is rejected.

Primary references:
[Getting started](https://api.hackerone.com/getting-started/) ·
[Customer API resources](https://api.hackerone.com/customer-resources/) ·
[Customer API reference](https://api.hackerone.com/customer-reference/) ·
[Asset types](https://docs.hackerone.com/en/articles/8486276-asset-types) ·
[Custom Fields](https://docs.hackerone.com/en/articles/8545034-custom-fields) ·
[Automations overview](https://docs.hackerone.com/en/articles/9653527-automations-overview).
