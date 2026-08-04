# ServiceNow (Veltrix app)

Manage **ServiceNow** configuration as code over the **Table API**, driven through
the Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detection → rollback).

> **Category:** SOAR · **Version:** 0.3.0 · **Auth:** HTTP Basic (integration user)

ServiceNow is a very large platform. This app manages a focused, high-signal
set of configuration types — each a clean, security-relevant, cleanly-writable
table — grouped into five sidebar groups. See **[Coverage](#coverage-v030)**
below for the full audited surface: every config-as-code table considered,
managed vs intentionally excluded, and why.

## What it manages

| Group | Config type | ServiceNow table | Identity |
|-------|-------------|-------------------|----------|
| Security & Access | **ACLs** | `sys_security_acl` | `(name, operation)` |
| Security & Access | **Roles** | `sys_user_role` | `name` |
| Platform Automation | **Business Rules** | `sys_script` | `(name, collection)` |
| Platform Automation | **Script Includes** | `sys_script_include` | `name` |
| Platform Automation | **Scheduled Jobs** | `sysauto_script` | `name` |
| Platform Automation | **Assignment Rules** | `sysrule_assignment` | `(name, table)` |
| Platform Automation | **UI Actions** | `sys_ui_action` | `(name, table)` |
| Forms & UI | **UI Policies** | `sys_ui_policy` | `(short_description, table)` |
| Forms & UI | **Data Policies** | `sys_data_policy2` | `(short_description, table)` |
| Forms & UI | **Client Scripts** | `sys_script_client` | `(name, table, type)` |
| Notifications | **Email Notifications** | `sysevent_email_action` | `(name, collection, event_name)` |
| Platform Settings | **System Properties** | `sys_properties` | `name` |

Every config type upserts a single table by its natural key
(query-then-`POST`/`PATCH` over the Table API), shares one audited engine
(`lib/tableConfig.ts`, driven by a `TableConfigSpec` per config type — except
System Properties, which layers a small password-safety wrapper on top, see
below), and runs the full pipeline (validate → deploy → health check → drift →
rollback). **Rollback** deletes records this app created and restores the
prior field values for records it updated.

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

### ACLs

An **Access Control rule** (ACL) is ServiceNow's core RBAC-enforcement record —
it gates create/read/write/delete/execute (and several specialized operations)
against a table or a specific field. This app manages `sys_security_acl`
records scoped to `type: record` (table/field security):

| Canvas field | `sys_security_acl` column | Notes |
|--------------|----------------------------|-------|
| Table / Field | `name` | **Derived**: `table` alone (table-level), or `table.field` (field-level), or `*` / `*.field` for a global rule |
| Operation | `operation` | `create` \| `read` \| `write` \| `delete` \| `execute` plus ServiceNow's specialized operations (`report_on`, `query_match`, `query_range`, ...) |
| Active | `active` | |
| Admin overrides | `admin_overrides` | Admins automatically pass this rule |
| Condition | `condition` | Encoded query the record must satisfy |
| Script | `script` | Must set the `answer` variable |
| Description | `description` | |

Identity is the `(name, operation)` pair, where `name` is derived from the
Table/Field inputs. `type` is fixed to `record` and is not a canvas field —
non-record ACL types (REST endpoints, UI pages, script includes, GraphQL, UX
routes, ...) are [out of scope](#coverage-v030).

> **SECURITY — role attachment is NOT managed here.** Which roles satisfy an
> ACL lives in the many-to-many join table `sys_security_acl_role`, not a
> column on this record — the same "related list, out of scope" pattern this
> app already applies to `sys_ui_policy_action`. **An ACL with no roles, no
> condition and no script PASSES FOR EVERY USER.** Always pair a managed ACL
> with a Condition and/or Script, or assign roles to it directly in ServiceNow
> after it deploys. `validate` warns on every ACL missing both.

### Roles

A **role** is the primary unit of ServiceNow RBAC — a named permission grant an
admin assigns to users/groups, and what ACLs check for:

| Canvas field | `sys_user_role` column | Notes |
|--------------|--------------------------|-------|
| Name | `name` | Identity. `<scope>.<name>` for a scoped-app role. ServiceNow does not allow renaming a role after it is saved — renaming this changes identity, creating a new role |
| Description | `description` | |
| Requires elevated privilege | `elevated_privilege` | User must explicitly elevate before the role's permissions apply |
| Requires subscription | `requires_subscription` | Gated behind a licensed subscription |
| Assignable by | `assignable_by` | **Raw, comma-separated role `sys_id`s** — advanced; this app does not resolve role names to ids for this field |

Identity is `name`. Role containment / inheritance
(`sys_user_role_contains_roles`) is [out of scope](#coverage-v030).

### Assignment Rules

An **assignment rule** auto-populates `assignment_group` / `assigned_to` on a
task-derived record after it saves, when those fields are still empty and the
rule's condition matches:

| Canvas field | `sysrule_assignment` column | Notes |
|--------------|-------------------------------|-------|
| Name | `name` | Identity (scoped to the table below) |
| Table | `table` | Must be a task-derived table (`incident`, `sn_si_incident`, `change_request`, ...) |
| Active | `active` | |
| Condition | `condition` | Encoded query gating the rule |
| Assignment group | `group` | **Raw sys_id** of the group |
| Assigned to | `user` | **Raw sys_id** of the user |
| Script | `script` | Server-side script for dynamic assignment (`current` in scope) |
| Order | `order` | Lower runs first (default 100) |
| Description | `description` | |

Identity is the `(name, table)` pair. `validate` warns when a rule sets none
of Group, User or Script (it would do nothing).

### UI Actions

A **UI action** creates a button, link or context-menu item on a form or list
that runs client and/or server script when triggered — the manually-invoked
counterpart to Business Rules:

| Canvas field(s) | `sys_ui_action` column(s) | Notes |
|-----------------|------------------------------|-------|
| Name / Table | `name` / `table` | Identity is the `(name, table)` pair |
| Action name | `action_name` | Internal identifier other scripts use to detect this action fired |
| Active / Order / Hint / Comments | `active` / `order` / `hint` / `comments` | |
| Placement (7 flags) | `form_button` / `form_link` / `form_context_menu` / `list_banner_button` / `list_choice` / `list_context_menu` / `list_link` | Where the action appears — at least one should be on |
| Show flags (4) | `show_insert` / `show_update` / `show_query` / `show_multiple_update` | Which record states offer the action |
| Client / Onclick / Isolate script | `client` / `onclick` / `isolate_script` | Client-side execution — Onclick is required when Client is on |
| Condition / Script | `condition` / `script` | Server-side gating and logic |

Identity is `(name, table)`. `validate` requires an Onclick function for a
Client action, warns when a non-client action has no Script, and warns when no
placement flag is enabled (the action would never appear anywhere).

### Data Policies

A **data policy** enforces field-level mandatory/read-only rules SERVER-SIDE
(import sets, web services, the UI) for a table. This app manages the policy
header record (the child `sys_data_policy_rule` per-field rules are out of
scope — the same pattern already applied to UI Policies' `sys_ui_policy_action`):

| Canvas field | `sys_data_policy2` column | Notes |
|--------------|------------------------------|-------|
| Short description | `short_description` | Identity (scoped to the table below) |
| Table | `table` | |
| Description | `description` | |
| Active / Order | `active` / `order` | |
| Conditions | `conditions` | Encoded query |
| Enforce UI policy | `enforce_ui` | Also apply as client-side UI Policy behavior |
| Reverse if false | `reverse_if_false` | |
| Apply to extended tables | `inherit` | |

Identity is `(short_description, table)`, the same shape as UI Policies. **Add
the field-level mandatory/read-only rules directly in ServiceNow** on the
policy's Data Policy Rules related list after it deploys.

### Client Scripts

A **client script** runs browser-side JavaScript on a form's `onLoad` /
`onChange` / `onSubmit` / `onCellEdit` event — the client-side counterpart to
Business Rules:

| Canvas field | `sys_script_client` column | Notes |
|--------------|-------------------------------|-------|
| Name / Table / Type | `name` / `table` / `type` | Identity is `(name, table, type)` |
| Field name | `field_name` | Required for `onChange` / `onCellEdit`; ignored otherwise |
| Script | `script` | |
| Active / Global / Order | `active` / `global` / `order` | |
| Applies to extended tables | `applies_extended` | |
| Isolate script | `isolate_script` | |
| UI type | `ui_type` | `desktop` \| `mobile_or_service_portal` \| `all` — **note:** a **string** enum, unlike UI Policies' integer-coded `ui_type` (`0`/`1`/`10`) — a genuine platform inconsistency, not a typo |

Identity is `(name, table, type)`.

### Email Notifications

An **email notification** sends email when a system event fires. This app
manages **event-driven notifications only** — the record-based Insert/Update
trigger mode uses fields not independently verified to this app's confidence
bar (see [Coverage](#coverage-v030)):

| Canvas field | `sysevent_email_action` column | Notes |
|--------------|-----------------------------------|-------|
| Name / Table / Event name | `name` / `collection` / `event_name` | Identity is the triple |
| Condition | `condition` | Additional encoded-query gate |
| Active / Weight / Mandatory | `active` / `weight` / `mandatory` | |
| Recipient users / groups | `recipient_users` / `recipient_groups` | **Raw, comma-separated sys_ids** |
| Recipient fields | `recipient_fields` | Plain field names, e.g. `caller_id` — no sys_id resolution needed |
| Subject / Message | `subject` / `message_html` | |
| Reply-to | `reply_to` | |

Identity is `(name, collection, event_name)`. **Pairs naturally with Business
Rules**: a rule can call `gs.eventQueue('my.event', current)` to raise the
event a notification here reacts to, giving a fully declarative trigger chain
across two config types.

### System Properties

A **system property** (glide property) is a global, instance-wide key/value
setting — many security-hardening settings (session timeout, login lockout,
MFA, CORS allow-lists, ...) are literally `sys_properties` entries:

| Canvas field | `sys_properties` column | Notes |
|--------------|----------------------------|-------|
| Name | `name` | Identity, conventionally dotted (`glide.security.foo`) |
| Type | `type` | `string` \| `integer` \| `boolean` \| `choicelist` \| `password` \| `password2` |
| Value | `value` | |
| Description | `description` | |
| Private | `is_private` | Hide from the System Properties list UI for non-admins |
| Ignore cache | `ignore_cache` | Take effect immediately, no node restart |
| Read roles / Write roles | `read_roles` / `write_roles` | **Plain, comma-separated role NAMES** — one of the few ServiceNow role fields stored as names, not sys_ids |

Identity is `name`.

> **PASSWORD SAFETY.** ServiceNow **masks** a `password`/`password2`
> property's value on every read — `GET` never returns the real secret.
> `deploy.ts` strips `value` from a password-type item's rollback snapshot
> before it's stored, so a later **rollback can never `PATCH` a masked
> placeholder back over the real secret** (the Table API `PATCH` is a partial
> update — omitting the key leaves the live value untouched).
> `driftDetect.ts` filters out the resulting always-mismatched `value` diff
> for those items. Every other field (`type`, `description`, `is_private`,
> `ignore_cache`, roles) is still diffed and restored normally. This is the
> one config type whose `deploy`/`driftDetect` are thin wrappers around the
> shared engine rather than the engine unmodified — see the comments in
> `config-types/system-properties/deploy.ts` and `driftDetect.ts`.

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
- ServiceNow SDK (Fluent) API reference, used to verify the columns backing
  v0.3.0's new config types (ACL, Role, EmailNotification, DataPolicy,
  AssignmentRule, UiAction, ClientScript, Property):
  https://servicenow.github.io/sdk/category/api-reference

## Setup

1. **Integration user** — in ServiceNow, create a dedicated integration user
   (User Administration → Users) with *Web service access only*. Different
   config types need different roles: `admin` (or `security_admin`) covers
   ACLs, Roles and System Properties; `admin` also covers the rest. Store the
   user name in the credential **username** field and the password in the
   **password** field. Scope the credential to only what you intend to manage.
2. **Connection** — on the **Connections** page, add a connection pointing at
   your instance address (e.g. `dev12345.service-now.com`) and attach the
   credential. **Test** runs `GET /api/now/table/sys_user?sysparm_limit=1`.
   Saving the connection also registers the instance as a deploy target.
3. **Author & deploy** — in the Configuration Canvas, pick a config type from
   any of the five groups (**Security & Access**, **Platform Automation**,
   **Forms & UI**, **Notifications**, **Platform Settings**), author your
   records, and deploy through the pipeline.

## Coverage (v0.3.0)

Coverage was audited against the ServiceNow Table API, the ServiceNow SDK
(Fluent) API reference (`servicenow.github.io/sdk`), and established
ServiceNow data-dictionary convention.

### Managed declarative platform/security configuration

| Group | Config type | Table(s) |
| --- | --- | --- |
| Security & Access | ACLs | `sys_security_acl` (type=record) |
| Security & Access | Roles | `sys_user_role` |
| Platform Automation | Business Rules | `sys_script` |
| Platform Automation | Script Includes | `sys_script_include` |
| Platform Automation | Scheduled Jobs | `sysauto_script` |
| Platform Automation | Assignment Rules | `sysrule_assignment` |
| Platform Automation | UI Actions | `sys_ui_action` |
| Forms & UI | UI Policies | `sys_ui_policy` |
| Forms & UI | Data Policies | `sys_data_policy2` |
| Forms & UI | Client Scripts | `sys_script_client` |
| Notifications | Email Notifications | `sysevent_email_action` (event-driven only) |
| Platform Settings | System Properties | `sys_properties` |

Every type upserts by a natural key an operator controls and captures
`rollbackData` per item so rollback can restore or delete exactly what this
app changed.

### Intentionally excluded — related/child lists

The same "manage the header record, exclude the child related list" pattern
applies consistently across this app:

- **ACL role attachment** (`sys_security_acl_role`) — a many-to-many join
  table, not a column on the ACL record. Assign roles to a managed ACL
  directly in ServiceNow, or gate it entirely with Condition/Script.
- **Role containment** (`sys_user_role_contains_roles`) — role inheritance is
  a related list, not a column on the role record.
- **Data Policy field rules** (`sys_data_policy_rule`) — the per-field
  mandatory/read-only rules that give a data policy its actual effect live in
  a child table; add them directly in ServiceNow after the header deploys.
- **UI Policy actions** (`sys_ui_policy_action`, unchanged from v0.2.0) — the
  per-field show/hide/mandatory/read-only actions a UI policy applies.

### Intentionally excluded — evaluated and dropped this release

- **SLA Definitions** (`contract_sla`) — SLA Definitions inherit from
  ServiceNow's legacy Contract Management data model, with unusually deep
  duration/schedule/retroactive-rule/workflow-linkage modeling. Several core
  column names could not be independently verified to this app's confidence
  bar, and a wrong write here is a **high-blast-radius, hard-to-detect**
  failure mode — a broken SLA definition can silently stop tracking incident
  response times rather than erroring visibly. Dropped rather than shipped at
  lower confidence; a candidate for a future release with live-instance
  verification.
- **Transform Maps** (`sys_transform_map` + `sys_transform_entry`) — a
  two-table field-mapping construct tied to Import Sets/Data Sources.
  Operational ETL/integration plumbing tied to a specific data-load workflow,
  not durable platform/security desired-state, and the child entry table's
  exact schema is not independently verified.
- **Catalog Items** (`sc_cat_item` + variables, variable sets, order guides,
  attached workflow/flow, pricing) — a deeply nested Service Catalog
  construct that would need its own subsystem to model safely. Not
  security/platform-config relevant, and the variable-set schema is far too
  large to represent as a single "cleanly-writable" table.
- **Flow Designer flows** (`sys_hub_flow`) **/ classic Workflow**
  (`wf_workflow`) — internal JSON/graph-based definitions without a stable,
  publicly documented Table-API schema for programmatic authoring. ServiceNow
  itself recommends the Flow Designer UI (or its own Flow API) over raw table
  writes for these. Already called out as future/out-of-scope in this app's
  manifest description since v0.1.0.
- **Choice Lists** (`sys_choice`), **Dictionary / field definitions**
  (`sys_dictionary`) and dictionary overrides — schema-as-code with
  instance-wide blast radius. A wrong dictionary write can corrupt a table's
  structure or break every form built on it — a fundamentally different risk
  class than the record-level automation/security config this app manages.
- **Reports, Dashboards, Homepages** (`sys_report`, Performance Analytics
  dashboards, homepage layouts) — presentation/analytics configuration, not
  security- or platform-behavior-relevant.

### Intentionally excluded — runtime/imperative or operational

- **Live Tools / action endpoints** (running a scheduled job on demand,
  executing an import set load, sending a test notification, impersonation)
  are one-shot operator actions, not durable desired state.
- **Per-record operational data** (incidents, changes, problems, catalog
  requests, CMDB CIs, and any other business/ITSM data) is not configuration
  — it is exactly what the config types in this app act *on* or *around*, not
  what they manage.
- **Read-only telemetry** (system logs, audit history `sys_audit`, event logs
  `sysevent`, performance metrics, License usage) has no write surface to
  manage as code.
- **Credential/API-key and SSO/SAML administration** is security-sensitive
  control-plane bootstrap (how you *reach* the instance), not canvas
  configuration — same category the connection/credential setup in this
  README covers, not a config type.

## Layout

```
apps/servicenow/
  manifest.yaml
  lib/servicenowApi.ts                 # Basic-auth Table API client
  lib/tableRecords.ts                  # generic record normalizers (bool/int/query/identity/CSV-set)
  lib/tableConfig.ts                   # generic upsert engine (deploy/rollback/drift/health/status) driven by a TableConfigSpec
  handlers/testConnection.ts           # connectivity test (sys_user probe)
  server/index.ts                      # /meta + /settings routes
  client/…                             # Overview, Setup Guide, Connections pages
  config-types/business-rules/         # sys_script              (Platform Automation)
  config-types/script-includes/        # sys_script_include      (Platform Automation)
  config-types/scheduled-jobs/         # sysauto_script          (Platform Automation)
  config-types/assignment-rules/       # sysrule_assignment      (Platform Automation)
  config-types/ui-actions/             # sys_ui_action           (Platform Automation)
  config-types/ui-policies/            # sys_ui_policy           (Forms & UI)
  config-types/data-policies/          # sys_data_policy2        (Forms & UI)
  config-types/client-scripts/         # sys_script_client       (Forms & UI)
  config-types/acls/                   # sys_security_acl        (Security & Access)
  config-types/roles/                  # sys_user_role           (Security & Access)
  config-types/email-notifications/    # sysevent_email_action   (Notifications)
  config-types/system-properties/      # sys_properties          (Platform Settings)
```

Each `config-types/<id>/` directory is a full 10-file config type: `canvas.yaml`,
`defaults.yaml`, `_shared.ts`, `validate.ts`, `deploy.ts`, `rollback.ts`,
`driftDetect.ts`, `healthCheck.ts`, `getStatus.ts` and `__tests__/<id>.test.ts`.

## Development

```
cd apps/servicenow
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs servicenow            # run handler tests
node ../../scripts/validate-app.mjs apps/servicenow    # validate against the app contract
```

## Scope, caveats & flagged items

- **Platform breadth.** ServiceNow spans ITSM, SecOps/SIR, Flow Designer, ACLs
  and much more. v0.3.0 covers twelve high-signal, cleanly-writable tables
  across five groups; see [Coverage](#coverage-v030) for everything considered
  and dropped, with reasons.
- **These config types write executable code / behavior / RBAC.** Deploying
  writes server-side JavaScript (business rules, script includes, scheduled
  jobs, assignment rules, UI actions), client-side JavaScript (client
  scripts), form/data behavior (UI/data policies), and RBAC primitives (ACLs,
  roles) or instance-wide settings (system properties) to the instance —
  several require a high-privilege role. Treat the credential accordingly.
- **`advanced` gates the business-rule script.** A `sys_script` record only runs
  its `script` when `advanced` is `true`; this config type manages *scripted*
  rules and defaults `advanced` on.
- **`api_name` is not written.** For script includes, ServiceNow auto-derives the
  read-only `api_name` (`{scope}.{name}`); this app manages only `name` and lets
  the instance derive it.
- **Raw sys_ids in several fields.** `scheduled-jobs.run_as`,
  `assignment-rules.group`/`user`, `roles.assignable_by` and
  `email-notifications.recipient_users`/`recipient_groups` all take **raw
  ServiceNow sys_ids** — this app does not resolve names to ids for these
  fields (the Table API has no generic "resolve by name" endpoint, and
  resolution would need a live lookup the deploy handler would have to do
  per-item). Copy sys_ids from the relevant record in ServiceNow.
  `system-properties.read_roles`/`write_roles` are the one exception — that
  column is genuinely stored as **plain role names**, not sys_ids.
- **Column-name confidence.** See each config type's section above and
  CHANGELOG's "Column confidence & caveats" for what is confirmed vs flagged
  per release. Business-rule column confidence is unchanged from 0.1.0 (see
  git history).
- **Identity uniqueness.** Identities are the natural keys an operator
  controls, not hard database uniqueness constraints ServiceNow enforces —
  e.g. ServiceNow allows multiple ACLs for the same `(name, operation)` (they
  combine via OR). This app's identity governs only the records **it**
  creates/updates; `validate` warns on a duplicate identity within one canvas.
- **No app database / BYOL.** This app holds no state of its own; all
  configuration lives in ServiceNow and in the platform's canvas/deployment
  records.
