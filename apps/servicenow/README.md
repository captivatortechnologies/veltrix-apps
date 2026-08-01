# ServiceNow (Veltrix app)

Manage **ServiceNow** configuration as code over the **Table API**, driven through
the Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detection → rollback).

> **Category:** SOAR · **Version:** 0.2.0 · **Auth:** HTTP Basic (integration user)

ServiceNow is a very large platform. This app is a focused, high-signal set of
configuration types — each a clean, security-relevant, cleanly-writable table —
with more to follow.

## What it manages

| Config type | ServiceNow table | Identity | Applied via |
|-------------|------------------|----------|-------------|
| **Business Rules** | `sys_script` | `(name, table)` | Table API (`POST`/`PATCH` `/api/now/table/sys_script`) |
| **UI Policies** | `sys_ui_policy` | `(short_description, table)` | Table API (`/api/now/table/sys_ui_policy`) |
| **Script Includes** | `sys_script_include` | `name` | Table API (`/api/now/table/sys_script_include`) |
| **Scheduled Jobs** | `sysauto_script` | `name` | Table API (`/api/now/table/sysauto_script`) |

Each config type upserts a single table by its natural key (query-then-`POST`/
`PATCH`), shares one audited engine (`lib/tableConfig.ts`, driven by a
`TableConfigSpec` per config type), and runs the full pipeline (validate →
deploy → health check → drift → rollback). **Rollback** deletes records this app
created and restores the prior field values for records it updated.

### Business Rules

A **business rule** is a server-side script that runs before / after / async, or
on query, for a given table. This app manages the fields that define one:

| Canvas field | `sys_script` column | Notes |
|--------------|---------------------|-------|
| Name | `name` | Identity (scoped to the table below) |
| Table | `collection` | Internal table name the rule runs on (e.g. `incident`, `sn_si_incident`) |
| Description | `description` | |
| When | `when` | `before` \| `after` \| `async` \| `display` |
| Order | `order` | Lower runs first (default 100) |
| Active | `active` | |
| Advanced | `advanced` | When on, the Script runs (defaults on) |
| On Insert / Update / Delete / Query | `action_insert` / `action_update` / `action_delete` / `action_query` | Which DB operations fire the rule |
| When to run | `filter_condition` | Encoded query, e.g. `active=true^priority=1` |
| Script | `script` | Server-side script body |

Rules are **upserted by their `(name, collection)` identity** — the deploy handler
queries `sys_script` for that pair, then `PATCH`es the existing record or `POST`s
a new one. Re-deploying is idempotent.

### UI Policies

A **UI policy** applies client-side form behavior (show/hide, mandatory,
read-only) to a table, driven by a condition. This app manages the policy record
(the child `sys_ui_policy_action` rows are out of scope):

| Canvas field | `sys_ui_policy` column | Notes |
|--------------|------------------------|-------|
| Short description | `short_description` | Identity (scoped to the table below) |
| Table | `table` | Internal table the policy applies to |
| Description | `description` | |
| UI type | `ui_type` | `0` Desktop \| `1` Mobile / Service Portal \| `10` All — **flagged**, verify stored values |
| Active / Global | `active` / `global` | |
| On load / Reverse if false / Run scripts | `on_load` / `reverse_if_false` / `run_scripts` | |
| Order | `order` | Lower runs first (default 100) |
| Conditions | `conditions` | Encoded query — **flagged** column name, verify per instance |

Identity is the `(short_description, table)` pair.

### Script Includes

A **script include** bundles reusable server-side logic (a class or function)
callable from business rules, scheduled scripts and — when client-callable —
client scripts via GlideAjax:

| Canvas field | `sys_script_include` column | Notes |
|--------------|-----------------------------|-------|
| Name | `name` | Identity — must match the class/function it defines |
| Description | `description` | |
| Active | `active` | |
| Client callable | `client_callable` | Reachable from the client via GlideAjax |
| Accessible from | `access` | `package_private` (default) \| `public` |
| Script | `script` | Server-side class/function body |

Identity is `name`. ServiceNow auto-derives the read-only `api_name`
(`{scope}.{name}`) — this app does **not** write it.

### Scheduled Jobs

A **scheduled job** (scheduled script execution) runs a server-side script on a
schedule, optionally under a specific user and gated by a condition:

| Canvas field | `sysauto_script` column | Notes |
|--------------|-------------------------|-------|
| Name | `name` | Identity |
| Active | `active` | |
| Run / Time / Start / Day of week / Interval | `run_type` / `run_time` / `run_start` / `run_dayofweek` / `run_period` | Schedule — **flagged**, verify names + `run_type` values per instance |
| Run as | `run_as` | User `sys_id` the script runs as |
| Conditional / Condition | `conditional` / `condition` | Condition script gating each run |
| Script | `script` | Server-side script body |

Identity is `name`.

All four config types **query-then-`PATCH`/`POST`** on their identity and record
`rollbackData` per item, so **rollback** deletes records this app created and
restores the prior field values for records it updated.

## The ServiceNow REST API (as used here)

- **Base:** `https://<instance>.service-now.com/api/now/`
- **Table API:** `GET /table/{table}` (list, filtered by `sysparm_query`),
  `GET /table/{table}/{sys_id}` (read), `POST /table/{table}` (create → `201`,
  returns the new record with its `sys_id`), `PATCH /table/{table}/{sys_id}`
  (partial update), `DELETE /table/{table}/{sys_id}` (`204`).
- **Response envelope:** every JSON payload is wrapped in a top-level `result`
  key (`{ "result": [...] }` for lists, `{ "result": {...} }` for single records).
- **Query:** `sysparm_query` (encoded query, GlideRecord syntax),
  `sysparm_limit`, `sysparm_fields`, `sysparm_display_value`.
- **Auth:** HTTP Basic — `Authorization: Basic base64(username:password)`. OAuth
  2.0 (`POST /oauth_token.do` → Bearer token) is ServiceNow's recommended
  production method and is a planned follow-up.

Docs:
- Table API — https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html
- Table API reference (methods, params, `result` envelope) — https://www.nowspectrum.com/blog/table-api-reference
- REST integration guide (auth, `result` envelope) — https://www.getknit.dev/blog/servicenow-rest-api-integration-guide
- Business rules / `sys_script` — https://www.servicenow.com/community/developer-articles/business-rule/ta-p/2329993
- ServiceNow SDK business-rule guide — https://servicenow.github.io/sdk/guides/business-rule-guide

## Setup

1. **Integration user** — in ServiceNow, create a dedicated integration user
   (User Administration → Users) with *Web service access only* and a role that
   can write `sys_script` (typically `admin`). Store the user name in the
   credential **username** field and the password in the **password** field.
2. **Connection** — on the **Connections** page, add a connection pointing at
   your instance address (e.g. `dev12345.service-now.com`) and attach the
   credential. **Test** runs `GET /api/now/table/sys_user?sysparm_limit=1`.
   Saving the connection also registers the instance as a deploy target.
3. **Author & deploy** — in the Configuration Canvas, pick a config type
   (**Business Rules**, **UI Policies**, **Script Includes** or **Scheduled
   Jobs**), author your records, and deploy through the pipeline. The role that
   can write `sys_script` (typically `admin`) also covers the other three tables.

## Scope, caveats & flagged items

- **Platform breadth.** ServiceNow spans ITSM, SecOps/SIR, Flow Designer, ACLs
  and much more. This release covers four high-signal, cleanly-writable tables
  (`sys_script`, `sys_ui_policy`, `sys_script_include`, `sysauto_script`); more
  will follow.
- **These config types write executable code / behavior.** Deploying writes
  server-side JavaScript (business rules, script includes, scheduled jobs) and
  form/scheduling behavior (UI policies) to the instance and requires a
  high-privilege role — treat the credential as such. That is what makes these
  *security-relevant* config surfaces.
- **`advanced` gates the business-rule script.** A `sys_script` record only runs
  its `script` when `advanced` is `true`; this config type manages *scripted*
  rules and defaults `advanced` on.
- **`api_name` is not written.** For script includes, ServiceNow auto-derives the
  read-only `api_name` (`{scope}.{name}`); this app manages only `name` and lets
  the instance derive it.
- **Column-name confidence.** Confirmed against ServiceNow docs/SDK and
  data-dictionary usage: `sys_script_include` `name` / `active` /
  `client_callable` / `access` (`package_private` \| `public`) / `script` /
  `description`, and `sysauto_script` `name` / `active` / `conditional` /
  `condition` / `script`. **Flagged (verify per instance):** `sys_ui_policy`
  `conditions` column name and `ui_type` stored integers (`0`/`1`/`10`); and the
  `sysauto_script` scheduling columns (`run_type`, `run_time`, `run_start`,
  `run_dayofweek`, `run_period`, `run_as`) and accepted `run_type` values.
  Business-rule column confidence is unchanged from 0.1.0 (see git history).
- **Identity uniqueness.** Identities are the natural keys an operator controls
  (`(name, collection)` for business rules, `(short_description, table)` for UI
  policies, `name` for script includes and scheduled jobs). ServiceNow enforces
  no hard uniqueness constraint on most of these, so upsert matches the first
  record with that identity.
- **No app database / BYOL.** This app holds no state of its own; all
  configuration lives in ServiceNow and in the platform's canvas/deployment
  records.

## Layout

```
apps/servicenow/
  manifest.yaml
  lib/servicenowApi.ts                 # Basic-auth Table API client
  lib/tableRecords.ts                  # generic record normalizers (bool/int/query/identity)
  lib/tableConfig.ts                   # generic upsert engine (deploy/rollback/drift/health/status) driven by a TableConfigSpec
  handlers/testConnection.ts           # connectivity test (sys_user probe)
  server/index.ts                      # /meta + /settings routes
  client/…                             # Overview, Setup Guide, Connections pages
  config-types/business-rules/         # canvas + defaults + 6 pipeline handlers + _shared + tests
  config-types/ui-policies/            # sys_ui_policy       (full 10-file config type)
  config-types/script-includes/        # sys_script_include  (full 10-file config type)
  config-types/scheduled-jobs/         # sysauto_script      (full 10-file config type)
```
