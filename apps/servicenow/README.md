# ServiceNow (Veltrix app)

Manage **ServiceNow** configuration as code over the **Table API**, driven through
the Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detection → rollback).

> **Category:** SOAR · **Version:** 0.1.0 · **Auth:** HTTP Basic (integration user)

ServiceNow is a very large platform. This app is a focused foundation: v0.1.0
manages **business rules** — one clean, security-relevant, writable surface —
with more configuration types to follow.

## What it manages

| Config type | ServiceNow table | Applied via |
|-------------|------------------|-------------|
| **Business Rules** | `sys_script` | Table API (`POST`/`PATCH` `/api/now/table/sys_script`) |

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
a new one. Re-deploying is idempotent. **Rollback** deletes rules this app created
and restores the prior field values for rules it updated.

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
3. **Author & deploy** — in the Configuration Canvas, pick **Business Rules**,
   author your rules, and deploy through the pipeline.

## Scope, caveats & flagged items

- **Platform breadth.** ServiceNow spans ITSM, SecOps/SIR, Flow Designer, ACLs
  and much more. This release intentionally covers a single table (`sys_script`).
- **Business rules are executable code.** Deploying writes server-side JavaScript
  to the instance and requires a high-privilege role — treat the credential as
  such. This is why business rules are a *security-relevant* config surface.
- **`advanced` gates the script.** A `sys_script` record only runs its `script`
  when `advanced` is `true`; simple rules use the action/set-value options
  instead. This config type manages *scripted* rules and defaults `advanced` on.
- **Column-name confidence.** `name`, `collection`, `when`, `order`, `active`,
  `advanced`, `action_query` and `script` are confirmed against ServiceNow
  data-dictionary usage; `action_insert` / `action_update` / `action_delete` and
  `filter_condition` follow the same well-established `action_*` / snake_case
  convention. Verify against your instance's `sys_script` dictionary if you have
  a heavily customized instance.
- **Identity uniqueness.** A business-rule `name` is not globally unique;
  identity here is the `(name, collection)` pair. ServiceNow enforces no hard
  uniqueness constraint on that pair either, so upsert matches the first record
  with that name on that table.
- **No app database / BYOL.** This app holds no state of its own; all
  configuration lives in ServiceNow and in the platform's canvas/deployment
  records.

## Layout

```
apps/servicenow/
  manifest.yaml
  lib/servicenowApi.ts                 # Basic-auth Table API client
  handlers/testConnection.ts           # connectivity test (sys_user probe)
  server/index.ts                      # /meta + /settings routes
  client/…                             # Overview, Setup Guide, Connections pages
  config-types/business-rules/         # canvas + defaults + 6 pipeline handlers + _shared + tests
```
