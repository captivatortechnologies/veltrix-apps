# Rapid7 InsightVM

Manage [Rapid7 InsightVM](https://www.rapid7.com/products/insightvm/) configuration as code through
the Security Console API (v3). Author configurations in the platform's Configuration Canvas and
deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift detection
and rollback are handled per configuration type.

> Scope: this app targets the on-prem **Security Console API v3** (`https://<console>:3780/api/3`),
> which carries the rich site/scan/credential config surface. The InsightIDR cloud API (detection
> rules) uses a different host + `X-Api-Key` auth and is out of scope for this app.

## Credentials

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

## What it manages

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
