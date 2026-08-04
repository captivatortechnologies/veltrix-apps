# Changelog — ServiceNow

All notable changes to the ServiceNow Veltrix app are documented here.

## 0.3.0 — 2026-08-04

Eight new configuration types, taking the app from four managed surfaces to
twelve. Every new type is a full pipeline config type (validate, deploy,
health check, drift detection, rollback) built on the existing single-table
upsert engine (`lib/tableConfig.ts`), grouped into five meaningful sidebar
groups: **Security & Access**, **Platform Automation**, **Forms & UI**,
**Notifications** and **Platform Settings**. See README's new **Coverage**
section for the full audited surface — every ServiceNow config-as-code table
considered, managed vs intentionally excluded, and why.

- **ACLs** (`sys_security_acl`, group Security & Access): manage Access
  Control rules as code — table/field target, operation (create/read/write/
  delete/execute plus ServiceNow's specialized operations), active,
  admin_overrides, condition and script. Scoped to `type: record` (table/field
  security); role attachment (the `sys_security_acl_role` join table) is out
  of scope, same as UI Policies' `sys_ui_policy_action` exclusion — `validate`
  warns on every ACL with neither a condition nor a script, since such a rule
  passes for every user.
- **Roles** (`sys_user_role`, group Security & Access): manage roles as code —
  name, description, `elevated_privilege`, `requires_subscription` and
  `assignable_by` (raw role sys_ids). Role containment
  (`sys_user_role_contains_roles`) is out of scope.
- **Assignment Rules** (`sysrule_assignment`, group Platform Automation):
  auto-populate `assignment_group`/`assigned_to` on a task-derived table —
  condition, static group/user (raw sys_ids) or a dynamic script, order.
- **UI Actions** (`sys_ui_action`, group Platform Automation): buttons, links
  and context-menu items on forms/lists that run client and/or server script —
  the manually-triggered counterpart to Business Rules. Manages all seven
  placement flags (form button/link/context menu, list banner button/choice/
  context menu/link), the four show flags (insert/update/query/multiple
  update), client/onclick/isolate_script and the condition/script.
- **Data Policies** (`sys_data_policy2`, group Forms & UI): server-side
  field mandatory/read-only enforcement for a table — short description,
  table, active, order, conditions, `enforce_ui`, `reverse_if_false`,
  `inherit`. The per-field rules (child `sys_data_policy_rule` table) are out
  of scope, same pattern as UI Policies.
- **Client Scripts** (`sys_script_client`, group Forms & UI): browser-side
  JavaScript for onLoad/onChange/onSubmit/onCellEdit — name, table, type,
  field_name (required for onChange/onCellEdit), script, active, global,
  order, `applies_extended`, `isolate_script` and the string-valued `ui_type`
  (desktop/mobile_or_service_portal/all — notably different from UI Policies'
  integer-coded `ui_type`, called out in README).
- **Email Notifications** (`sysevent_email_action`, group Notifications):
  event-driven notifications only (event name required) — table, condition,
  subject, HTML message, recipient users/groups (raw sys_ids) and recipient
  fields (plain field names), weight, mandatory, reply-to. Pairs naturally
  with Business Rules: a rule can raise a custom event
  (`gs.eventQueue('name', current)`) that a notification reacts to.
- **System Properties** (`sys_properties`, group Platform Settings):
  instance-wide configuration and security-hardening settings — name, value,
  type (string/integer/boolean/choicelist/password/password2), description,
  `is_private`, `ignore_cache`, and `read_roles`/`write_roles` (plain role
  names — one of the few ServiceNow role fields stored as names, not
  sys_ids). **Password safety**: ServiceNow masks a password/password2
  property's value on every read. `deploy.ts` strips `value` from a
  password-type item's rollback snapshot so rollback can never PATCH a masked
  placeholder back over the real secret; `driftDetect.ts` filters out the
  resulting always-mismatched `value` diff for those items. This is the one
  new config type that does not use the generic engine unmodified — see its
  `deploy.ts`/`driftDetect.ts` comments.
- **Shared engine enhancement** (`lib/tableConfig.ts` + `lib/tableRecords.ts`):
  added `setColumns` — comma-separated "list" columns (e.g. `recipient_users`,
  `assignable_by`, `read_roles`) are now compared order-insensitively for
  drift, avoiding false-positive drift when ServiceNow or an operator
  reorders a list. Added `readStringArray`/`joinCsv`/`normalizeCsvSet`/
  `csvSetEqual` helpers, reused by every new list-valued field.

### Column confidence & caveats

Researched against the ServiceNow SDK (Fluent) API reference
(`servicenow.github.io/sdk`), which documents the same underlying tables this
app writes via the Table API, plus established ServiceNow data-dictionary
convention. Confirmed vs flagged:

- **Confirmed:** `sys_user_role` (`elevated_privilege`, `requires_subscription`,
  `assignable_by`), `sysrule_assignment` (`table`, `condition`, `group`,
  `user`, `script`, `order`), `sys_script_client` (`type` enum onLoad/
  onChange/onSubmit/onCellEdit, `field_name`, `applies_extended`,
  `isolate_script`, `ui_type` string enum), `sys_properties` (`name`, `value`,
  `type` enum, `description`, `is_private`, `ignore_cache`).
- **Flagged (verify against your instance's dictionary):**
  - `sys_security_acl` — the `name` column is written as a single composite
    "table" or "table.field" string (ServiceNow's well-documented but easy to
    mis-recall ACL-naming convention); the full `operation` enum beyond
    create/read/write/delete/execute is included but rarely used.
  - `sys_data_policy2` — `enforce_ui` and `inherit` follow ServiceNow's
    Data-Policy-mirrors-UI-Policy convention but are not independently
    re-verified to the same confidence as `short_description`/`table`/
    `conditions`/`reverse_if_false` (shared, confirmed column names with
    `sys_ui_policy`).
  - `sysevent_email_action` — scoped to **event-driven notifications only**
    (`event_name` required); the record-based Insert/Update trigger mode is
    out of scope because its gating field names are not independently
    verified. `read_roles`/`write_roles`-style CSV columns are used
    elsewhere in this release with higher confidence than the notification
    recipient fields, which are still Table-API `glide_list`/CSV columns but
    less extensively cross-checked.
  - `sys_ui_action` — the seven placement columns (`form_button`,
    `form_link`, `form_context_menu`, `list_banner_button`, `list_choice`,
    `list_context_menu`, `list_link`) and four show columns are corroborated
    by two independent sources (the ServiceNow SDK UiAction API and a
    third-party ServiceNow admin reference) but not a live instance.

### Scope & caveats (unchanged from 0.2.0)

- ServiceNow spans ITSM, SecOps/SIR, Flow Designer, ACLs and much more; see
  README's Coverage section for the full audited list of what is managed vs
  intentionally excluded, including SLA Definitions, Transform Maps, Catalog
  Items and Flow Designer flows — all evaluated and dropped this release with
  reasons.
- Authentication is HTTP Basic only. OAuth 2.0 (`/oauth_token.do` → Bearer) is
  a planned follow-up.
- Business Rules, Script Includes, Scheduled Jobs, Assignment Rules, UI
  Actions and Client Scripts all write executable code to the instance;
  ACLs, Roles and System Properties are core RBAC/security-posture surfaces —
  treat the integration credential accordingly (typically `admin`).

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
