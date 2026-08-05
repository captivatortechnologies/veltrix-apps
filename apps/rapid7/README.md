# Rapid7 InsightVM & InsightIDR

Manage [Rapid7](https://www.rapid7.com/) configuration as code across two APIs. Author
configurations in the platform's Configuration Canvas and deploy them through the Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback are handled per
configuration type.

- **InsightVM** — the on-prem **Security Console API v3** (`https://<console>:3780/api/3`), which
  carries the rich site/scan/credential config surface. HTTP Basic auth.
- **InsightIDR** — the **Insight Platform Detection Rules API v1**
  (`https://<region>.api.insight.rapid7.com/idr/v1`), the region-scoped cloud SIEM. `X-Api-Key` auth.

## Credentials

### InsightVM (Security Console)

The console v3 API uses **HTTP Basic** auth (there is no API-key option). Create a console **service
account** (Administration → Users) with a role scoped to what this app manages, and store it as a
Veltrix credential:

| Veltrix credential field | InsightVM value |
| --- | --- |
| Username | The console username |
| Password | The console password |

Prefer a **non-2FA** account for automation; for a 2FA account, set the **2FA Token** app setting per
run. Register an **`insightvm-console`** component whose hostname is your Security Console host (e.g.
`console.example.com:3780`) — port `3780` is assumed when omitted. The console serves HTTPS with a
self-signed certificate by default, so the platform host must trust the console's certificate.

### InsightIDR (Insight Platform)

The Insight Platform API uses a single **`X-Api-Key`** header. Create an **Organization** API key in
the Insight platform (Platform Home → API Keys) and store it in the credential's **API token** field.
Register an **`insightidr-org`** component whose hostname encodes your data-residency region — either
the API host (`us.api.insight.rapid7.com`) or the bare region code (`us`, `us2`, `us3`, `eu`, `ca`,
`au`, `ap`). The region can also be set with the **InsightIDR Region** app setting; the component
hostname always wins. Region cannot be auto-discovered, so it must be supplied.

## What it manages

### InsightVM — Security Console API v3

| Configuration type | Object | Endpoint |
| --- | --- | --- |
| Sites | Scan sites (targets, engine, template, importance) | `/sites` |
| Asset Groups | Static / dynamic asset groups | `/asset_groups` |
| Tags | Criticality / location / owner / custom tags | `/tags` |
| Scan Templates | Scan configurations | `/scan_templates` |
| Shared Credentials | Org-wide scan credentials (secret) | `/shared_credentials` |
| Scan Engine Pools | Engine pools + membership | `/scan_engine_pools` |
| Vulnerability Exceptions | Exceptions with scope/expiration | `/vulnerability_exceptions` |
| Scan Schedules | Per-site scan schedules | `/sites/{id}/scan_schedules` |
| Site Credentials | Site-scoped credentials (secret) | `/sites/{id}/site_credentials` |
| Policy Overrides | Compliance (Policy Manager) rule overrides, scoped to one/all assets | `/policy_overrides` |
| Report Configurations | Report definitions — template, format, scope, schedule | `/reports` |
| Sonar Queries | Saved Project Sonar discovery searches | `/sonar_queries` |
| Console Users | Local console users — role, site/asset group access (secret password) | `/users` |

### InsightIDR — Insight Platform Detection Rules API v1

| Configuration type | Object | Endpoint |
| --- | --- | --- |
| Detection Rule Exceptions | Rule exceptions (SIMPLE key-value or LEQL) attached to a rule by name | `/idr/v1/rules/{rrn}/rule-exceptions` |
| Detection Rule Settings | A rule's action + priority, set by rule name | `/idr/v1/rules/update` |

InsightIDR rules are addressed by their portable **name**; the app resolves the name to the
environment-specific Rapid7 Resource Name (RRN) via `GET /idr/v1/rules` at deploy time. Rule
exceptions are **create/skip** (deleted on rollback); rule settings write only changed fields and
restore the prior values on rollback. Investigations (`/idr/v2/investigations`) are runtime incident
records rather than declarative configuration and are intentionally not modeled.

## Coverage

A per-product breakdown of what this app manages as code, what it deliberately leaves out, and why —
last audited 2026-08-05 against the console v3 API surface (cross-referenced with Rapid7's
[official OpenAPI-generated Python client](https://github.com/rapid7/vm-console-client-python), which
mirrors the same `/api/3` resource set the console's ReDoc reference documents) and the InsightIDR /
Insight Platform REST APIs (`docs.rapid7.com`).

### InsightVM (Security Console API v3) — managed

| Configuration type | Endpoint(s) | Notes |
| --- | --- | --- |
| Sites | `/sites`, `/sites/{id}/scan_schedules`, `/sites/{id}/site_credentials` | Full CRUD; schedules/credentials are child resources |
| Asset Groups | `/asset_groups` | Static + dynamic (search-criteria JSON) |
| Tags | `/tags` | Built-in tags protected |
| Scan Templates | `/scan_templates` | User-settable string id; built-ins cloned, not overwritten |
| Scan Engine Pools | `/scan_engine_pools`, `/scan_engines` (read, for name→id) | Member engines declared by name |
| Shared / Site Credentials | `/shared_credentials`, `/sites/{id}/site_credentials` | Secret is write-only, always re-sent |
| Vulnerability Exceptions | `/vulnerability_exceptions` | Create/skip — the API has no update |
| **Policy Overrides** *(new)* | `/policy_overrides` | Create/skip — `PolicyOverrideApi` has no update, only expiration/status workflow actions (see Dropped) |
| **Report Configurations** *(new)* | `/reports` | Full CRUD on the report's config document; scope resolved from site/asset-group/tag names |
| **Sonar Queries** *(new)* | `/sonar_queries` | Full CRUD (`AssetDiscoveryApi`); a saved internet-scan search used for asset discovery |
| **Console Users** *(new)* | `/users`, `/users/{id}/sites`, `/users/{id}/asset_groups` | Password required by the API on every write; site/asset-group access reconciled every deploy |

### InsightVM — considered and dropped (honest gaps)

| Candidate | Endpoint(s) | Why it's dropped |
| --- | --- | --- |
| Scan engine registration | *(none — console UI pairing only)* | Pairing a physical/virtual engine to the console exchanges a shared secret out-of-band; there is no v3 endpoint to register a new engine, only to list existing ones and manage pool membership (already covered) |
| Policy / policy rule definitions | `/policies/*` (`PolicyApi`) | Entirely read-only — every one of its ~30 methods is a `GET`; policies and their rules come from Rapid7-shipped benchmarks and cannot be authored |
| Report templates | `/report_templates` | Read-only (`get_report_templates`/`get_report_template`); reference an existing template id from **Report Configurations** above |
| Report generation & output | `/reports/{id}/generate`, `/reports/{id}/history/*` | One-shot action (triggers a run) and read-only artifacts, not declarative config |
| Discovery Connections | `/discovery_connections` | Read + reconnect only (`AssetDiscoveryApi`) — no create/update/delete; a connection (vCenter, DHCP, ActiveSync) is provisioned outside the API |
| Policy override expiration/status changes | `/policy_overrides/{id}/expires`, `/policy_overrides/{id}/{status}` | Real write endpoints, but they are review-workflow actions (recall/approve/reject an existing override) rather than declarative config — out of scope, matching how this app treats InsightIDR investigation triage |
| Role definitions (privilege sets) | `/roles/{id}` (`UserApi`) | Update/delete only — there is no `create_role`; a role must already exist (built-in or console-authored) before it can be referenced by **Console Users** |
| Blackout windows | *(none found)* | No `Blackout` resource/model exists anywhere in the v3 API surface (confirmed against the full client method/model inventory) — scan blackouts are console-UI-only in this API generation |
| Findings / assets / vulnerabilities | `/assets`, `/vulnerabilities`, `/asset_vulnerabilities` | Read-only scan results, not configuration |

### InsightIDR (Insight Platform) — considered and dropped

| Candidate | Endpoint(s) | Why it's dropped |
| --- | --- | --- |
| Custom Threat Intelligence | `/idr/v1/customthreats`, `.../indicators/add`, `.../indicators/replace` | Create/add/replace-indicators write endpoints exist (confirmed via Rapid7's own `rapid7_insightidr` InsightConnect plugin), but **no list/get-by-name endpoint is documented or implemented anywhere** — without one, a deploy cannot detect an already-created threat, so every redeploy would create a duplicate. Not sufficiently round-trippable to meet this app's reconciliation bar |
| Log Search / log sets | `log-search-api` | The same InsightConnect plugin exposes only read/query actions (`get_a_log`, `get_all_logs`, advanced query) for logs and log sets — no create/update action for either was found, suggesting log sets are provisioned by event-source/collector configuration rather than declared directly |
| Alert triage | alert-triage API | `PATCH`-based update exists, but it mutates an alert's live disposition/assignee — an operational SOC action, not declarative config (same category as Investigations, below) |
| Investigations | `/idr/v1/investigations`, `/idr/v2/investigations` | Runtime incident records, not configuration (unchanged from prior releases of this app) |
| Comments / Attachments | Investigations API | Case-management artifacts tied to a specific investigation/alert, not standalone config |
| Accounts & Users (platform-wide) | Insight Platform Accounts API | Read-only search/retrieval; Insight Platform organization users are a separate concern from the InsightVM console users this app now manages |

## InsightVM-specific behaviour the app handles

- **No native upsert.** Every type lists the collection (HAL `page`/`size` pagination, size 500),
  matches by natural key (`name`, or `name`+`type` for tags, string `id` for scan templates), then
  POSTs a new object or PUTs `/{id}` (full replace).
- **Child-of-site types** (scan schedules, site credentials) reference their site by **name**; the app
  resolves the site id first and manages the sub-resource under it.
- **Write-only secrets.** Shared/site credential secrets (passwords, keys) are supplied from the
  platform credential store and never diffed — the API masks them on read.
- **Protected objects are never modified**: built-in (`source: built-in`) tags, and built-in scan
  templates (the app clones to customize rather than overwriting a built-in id).
- The large, type-dependent parts (dynamic asset-group / tag `searchCriteria`, scan-template config,
  scan-schedule recurrence, exception scope, report config, Sonar criteria) are authored as JSON in
  the canvas.
- **Create/skip-only types** (Vulnerability Exceptions, Policy Overrides): the console offers no
  in-place update, so an already-present item (matched by its natural key) is left untouched and only
  newly-created items are recorded for rollback (deleted on revert).
- **Name-resolved scope** (Report Configurations, Console Users): sites, asset groups and tags are
  declared by name and resolved to ids at deploy time from a fresh listing; an unknown name fails the
  deploy before any write happens, the same pattern Scan Engine Pools uses to resolve engine names.
- **Multi-call reconciliation** (Console Users): a user's identity/role is one call
  (`PUT`/`POST /users`), but site and asset group access are separate calls
  (`PUT /users/{id}/sites`, `PUT /users/{id}/asset_groups`) issued on every deploy — including with an
  empty list — so access no longer declared in the canvas is actually revoked, not just left stale.
- **Defensive listing** (Sonar Queries): `GET /sonar_queries` takes no pagination parameters and may
  return either a HAL `{ resources }` envelope or a bare array; the client handles both rather than
  assuming the paged shape every other collection in this API uses.

## Health check

Handlers make a cheap authenticated read (a paged list) to prove the console credential works before
doing any work, then confirm each declared object is present.

## References

- InsightVM API v3: <https://help.rapid7.com/insightvm/en-us/api/index.html>
- InsightVM API v3 resource/model inventory (used to verify the Coverage section above, since the
  ReDoc reference renders its spec client-side): <https://github.com/rapid7/vm-console-client-python>
- Insight platform: <https://docs.rapid7.com/insight/api-overview/>
- InsightIDR REST APIs overview: <https://docs.rapid7.com/insightidr/insightidr-rest-api/>
- InsightIDR InsightConnect plugin (used to confirm actual custom-threat/log-search write surface):
  <https://github.com/rapid7/insightconnect-plugins/tree/master/plugins/rapid7_insightidr>
