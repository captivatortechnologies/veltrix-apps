# Qualys (Veltrix app)

Manage **Qualys VMDR / Policy Compliance** configuration as code through the
classic **v2 API**. Authoring happens in the Veltrix Configuration Canvas; every
write goes through the Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

## What it manages

| Configuration type        | Qualys endpoint                           | Identity (natural key) |
| ------------------------- | ----------------------------------------- | ---------------------- |
| **Qualys Asset Groups**   | `/api/2.0/fo/asset/group/`                | Title                  |
| **Qualys Search Lists**   | `/api/2.0/fo/qid/search_list/static/`     | Title                  |
| **Qualys Scan Schedules** | `/api/2.0/fo/schedule/scan/`              | Scan title             |

Each type reconciles by its natural key: the deploy handler lists the live
objects, matches on the title, then **edits/updates** the matching object or
**adds/creates** a new one. Rollback deletes anything this deployment created and
restores anything it updated (best-effort for scan schedules — see Limitations).

## Authentication

Qualys is a multi-POD SaaS. Each subscription lives on one **platform** whose API
server is a fixed hostname — the component hostname. Find yours under **Help >
About** in the Qualys UI. Examples:

| Platform | API server                          |
| -------- | ----------------------------------- |
| US1      | `qualysapi.qualys.com`              |
| US2      | `qualysapi.qg2.apps.qualys.com`     |
| US3      | `qualysapi.qg3.apps.qualys.com`     |
| EU1      | `qualysapi.qg1.apps.qualys.eu`      |
| IN1      | `qualysapi.qg1.apps.qualys.in`      |

- **Auth:** HTTP Basic (a Qualys account username + password).
- Every classic v2 call additionally sends the **`X-Requested-With`** header
  Qualys requires as a CSRF guard (omitting it returns HTTP 400).
- Requests are form-encoded POSTs; responses are XML.
- Rate / concurrency limits surface as **HTTP 409** with `X-RateLimit-*` /
  `X-Concurrency-Limit-*` response headers.

## Setup

1. **API account** — create a dedicated Qualys service account with **API access**
   enabled and a role scoped to what this app manages.
2. **Credential** — store the account as a Veltrix credential: **username** →
   Qualys username, **password** → Qualys password.
3. **Component** — register a **`qualys-platform`** component whose hostname is
   your platform API server (Help > About) and attach the credential.
4. **Connections** — use the app's Connections page to verify the platform URL +
   credential with a live probe
   (`GET /api/2.0/fo/asset/group/?action=list&truncation_limit=1`).

## Configuration notes

- **Asset Groups** — `title` must be unique and cannot be `All`. `ips` is a
  comma/whitespace-separated list of IPs, ranges (`10.0.0.1-10.0.0.254`) and CIDR
  blocks; it overwrites the group's IP set on each deploy. `network_id` applies
  only to subscriptions with the Network Support feature.
- **Search Lists** — static lists of numeric QIDs. The full QID set is replaced on
  each deploy (`qids`, which the API forbids mixing with add/remove).
- **Scan Schedules** — reference an existing option profile by `option_title` and
  target existing asset groups by `asset_group_titles`. Timing and any extra
  Qualys schedule parameters go in `schedule_json`, a flat JSON object that must
  include an `occurrence` (`daily` | `weekly` | `monthly`), e.g.
  `{"occurrence":"weekly","frequency_weeks":1,"weekdays":"1","start_date":"08/01/2026","start_hour":2,"start_minute":0,"time_zone_code":"US-CA"}`.

## Limitations

- Write-only secrets (the credential password) are never read back, diffed, or
  stored in rollback data / artifacts / logs.
- **Scan schedule rollback** is best-effort: the classic list API does not return
  a schedule's full recurrence in a re-submittable form, so an *updated* schedule
  is restored only for its title / active flag / option profile — created
  schedules roll back cleanly (deleted). Drift detection for schedules compares
  the fields the list API exposes (active flag, option profile).
- The app writes only through the Qualys API; it registers no platform-side
  database tables or background jobs.

## Development

```
cd apps/qualys
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs qualys           # run the validate tests
node ../../scripts/validate-app.mjs apps/qualys    # (from repo root) manifest + bundle checks
```
