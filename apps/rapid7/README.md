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
  scan-schedule recurrence, exception scope) are authored as JSON in the canvas.

## Health check

Handlers make a cheap authenticated read (a paged list) to prove the console credential works before
doing any work, then confirm each declared object is present.

## References

- InsightVM API v3: <https://help.rapid7.com/insightvm/en-us/api/index.html>
- Insight platform: <https://docs.rapid7.com/insight/api-overview/>
