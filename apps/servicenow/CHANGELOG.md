# Changelog — ServiceNow

All notable changes to the ServiceNow Veltrix app are documented here.

## 0.2.0 — 2026-08-01

Three new configuration types, taking the app from one managed surface to four.
Each is a full pipeline config type (validate, deploy, health check, drift
detection, rollback) that upserts a single ServiceNow table by a natural key
(query-then-`PATCH`/`POST`), reusing the existing Table API client.

- **UI Policies** (`sys_ui_policy`): manage client-side form behavior as code —
  short description, table, `ui_type`, active/global/on-load/reverse-if-false/
  run-scripts flags, order and the encoded `conditions`. Identity is the
  `(short_description, table)` pair.
- **Script Includes** (`sys_script_include`): manage reusable server-side
  classes/functions as code — name, description, active, `client_callable`,
  `access` (`package_private` / `public`) and the `script`. Identity is `name`.
- **Scheduled Jobs** (`sysauto_script`): manage scheduled server-side scripts as
  code — name, active, schedule (`run_type` / `run_time` / `run_start` /
  `run_dayofweek` / `run_period`), `run_as`, `conditional` / `condition` and the
  `script`. Identity is `name`.
- **Shared table-config engine** (`lib/tableConfig.ts` + `lib/tableRecords.ts`):
  a declarative `TableConfigSpec` drives generic deploy / rollback / drift /
  health / status for any single-table upsert config type, so the three new
  types (and future ones) share one audited implementation of the query-then-
  `PATCH`/`POST` pattern. Rollback deletes records this app created and restores
  prior field values for records it updated. (The original Business Rules config
  type is unchanged.)

### Column confidence & caveats

Column names and choice values were researched against ServiceNow's official
docs/SDK and long-established data-dictionary conventions. Confirmed vs flagged:

- **Confirmed:** `sys_script_include` — `name`, `active`, `client_callable`,
  `script`, `description`, and `access` with values `package_private` (default)
  and `public` (per the ServiceNow SDK `accessibleFrom` property). `api_name` is
  auto-derived by ServiceNow from `{scope}.{name}` and is read-only in practice,
  so this app does **not** write it.
- **Confirmed:** `sysauto_script` — `name`, `active`, `conditional`,
  `condition`, `script`.
- **Flagged (verify against your instance's dictionary):**
  - `sys_ui_policy` — the `conditions` encoded-query column name and the
    `ui_type` stored integer values (`0` Desktop, `1` Mobile / Service Portal,
    `10` All) follow ServiceNow convention; the field labels are confirmed but
    the exact stored values can differ on customized instances.
  - `sysauto_script` — the scheduling columns `run_type`, `run_time`,
    `run_start`, `run_dayofweek`, `run_period` and `run_as` follow the
    `sysauto`/`sysauto_script` convention; the accepted `run_type` values beyond
    the common six (daily/weekly/monthly/periodically/once/on_demand) and exact
    column names should be verified per instance.

### Scope & caveats (unchanged from 0.1.0)

- ServiceNow spans ITSM, SecOps/SIR, Flow Designer, ACLs and much more. v0.2.0
  covers four high-signal, cleanly-writable tables; more will follow.
- Authentication is HTTP Basic only. OAuth 2.0 (`/oauth_token.do` → Bearer) is a
  planned follow-up.
- These config types write executable server-side code and form/scheduling
  behavior to the instance and typically require the `admin` role — treat the
  integration credential accordingly.

## 0.1.0 — 2026-08-01

Initial foundation.

- **Business Rules** configuration type (`sys_script`): manage ServiceNow
  business rules as code — name, table (`collection`), timing (`when`:
  before/after/async/display), execution order, active/advanced flags, database
  triggers (insert/update/delete/query), an encoded filter condition and the
  server-side script — through the full Security-as-Code pipeline (validate,
  deploy, health check, drift detection, rollback).
- **Table API client** (`lib/servicenowApi.ts`): HTTP Basic-auth client for the
  ServiceNow Table API (`/api/now/table/{table}`) with list / get / create
  (POST) / update (PATCH) / delete, the `result` envelope helpers, and a request
  timeout setting.
- **Upsert by natural key**: rules are matched by their `(name, collection)`
  identity — query-then-POST/PATCH — so re-deploying is idempotent. Rollback
  deletes rules this app created and restores prior field values for rules it
  updated.
- **Connections**: instance address + integration-user username/password, with a
  per-row connectivity test (`GET /api/now/table/sys_user?sysparm_limit=1`).
- **Overview** and **Setup Guide** pages.

### Scope & caveats

- ServiceNow is a very large platform. v0.1.0 deliberately manages a single,
  security-relevant, cleanly-writable surface (business rules). More
  configuration types will follow.
- Authentication is HTTP Basic only in this release. OAuth 2.0
  (`/oauth_token.do` → Bearer) is ServiceNow's recommended production method and
  is a planned follow-up.
- Writing business rules writes executable server-side code to the instance and
  typically requires the `admin` role — treat the integration credential
  accordingly.
