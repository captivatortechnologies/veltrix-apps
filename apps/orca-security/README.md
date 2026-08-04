# Orca Security (Veltrix app)

Manage [Orca Security](https://orca.security) (agentless CNAPP / CSPM)
configuration as code through the **Orca REST API**, driven by the Veltrix
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

As of **v0.3.0** it manages **eleven** configuration types. The original four
(custom alerts, business units, automations, discovery views) shipped in
v0.2.0; v0.3.0 adds seven more from a full research-first exhaustion pass over
Orca's config-as-code write surface — see **Coverage** below for what was
checked, what shipped and what was deliberately left out, with reasons.

## What it manages

| Configuration type | Orca object | REST endpoints |
| --- | --- | --- |
| **Custom Alerts** (`custom-alerts`) | Custom Sonar rules | `POST /api/sonar/rules`, `GET/PUT/DELETE /api/sonar/rules/{id}` |
| **Business Units** (`business-units`) | Filters | `POST /api/filters`, `GET/PUT/DELETE /api/filters/{id}` |
| **Automations** (`automations`) | Automations | `POST /api/automations`, `GET/PUT/DELETE /api/automations/{id}`, `GET /api/automations?limit=&start_at_index=` (list) |
| **Discovery Views** (`discovery-views`) | Saved user preferences | `POST /api/user_preferences`, `GET/PUT/DELETE /api/user_preferences/{id}` |
| **Custom Compliance Frameworks** (`custom-compliance-frameworks`) | Compliance frameworks | `POST /api/compliance/frameworks`, `GET/PUT/DELETE /api/compliance/frameworks/{id}` |
| **Alert Exceptions** (`alert-exceptions`) | Built-in system alert enabled state | `GET /api/sonar/rules/{rule_id}`, `PUT /api/sonar/rules/status/{rule_id}` |
| **Discovery Alerts** (`discovery-alerts`) | Discovery-based custom alerts | `POST /api/sonar/rules`, `GET/PUT/DELETE /api/sonar/rules/{id}` |
| **Notification Integrations** (`notification-integrations`) | Jira Cloud / Slack / webhook templates | `POST /api/external_service/config`, `GET /api/external_service/config?service_name=&template_name=`, `PUT/DELETE /api/external_service/config/{service}?template=` |
| **Custom Tag Rules** (`custom-tag-rules`) | Custom tag rules | `POST /api/custom_tags`, `GET/PUT/DELETE /api/custom_tags/{id}` |
| **Custom Roles** (`custom-roles`) | RBAC role definitions | `POST /api/rbac/roles`, `GET/PUT/DELETE /api/rbac/roles/{id}` |
| **Trusted Cloud Accounts** (`trusted-cloud-accounts`) | Trusted cloud accounts | `POST /api/organization/trusted_accounts`, `GET/PUT/DELETE /api/organization/trusted_accounts?id=` |

Every configuration type targets an `orca-tenant` component and reconciles by the
server id it **assigns on create and persists** in the deployment's
`rollbackData` (recovered by the stable canvas item id first — supporting rename
— then by name) — **except** Alert Exceptions (identity is the caller-supplied
`rule_id` of an existing built-in alert) and Notification Integrations (identity
resolves live by `(service, template_name)`, which Orca's own API can look up
directly). The shared, network-free reconciliation helpers live in
[`lib/reconcile.ts`](lib/reconcile.ts).

### Custom alerts (custom Sonar rules)

An Orca **custom alert** pairs a **Sonar (DSL) query** (`rule`) with a
`category`, a base **risk score** (`orca_score`), a `context_score` flag (let
Orca adjust the score using asset context) and an `enabled` flag. A matching
asset raises an alert at the configured score.

The write path is **first-class** — create, update and delete are all documented
Orca API operations. Orca does **not** publish a "list custom rules" endpoint
(its own Terraform provider tracks the returned `rule_id` in state), so this app
reconciles by the **rule id it assigns on create and persists** in the
deployment's `rollbackData`. Each subsequent deploy reads its own prior
`rollbackData` (via `ctx.platform.getLatestDeployment`) to recover each item's
`rule_id`, matching by the **stable canvas item id first** (so a rule can be
**renamed** without losing identity) and then by name. On the very first deploy
of a configuration every item is created.

Rollback deletes rules this app created and restores the prior body of rules it
updated.

### Business units (filters)

An Orca **business unit** is a named **filter** (`/api/filters`) that scopes
findings to a set of resources selected by **one** filter type — cloud providers,
cloud accounts (vendor IDs), custom tags, cloud tags/labels or cloud account tags
— plus ownership metadata (`business_criticality`, `owner_team`, `application`,
up to two `contact_emails` and two `deployment_stages`). Orca does **not** allow
mixing filter types in one unit, so the canvas exposes a filter-type select plus
a value list; leave it **Org-wide** for a global unit. The server id is
`filter_id`. (Note: the resource lives under `/api/filters`, **not**
`/api/business_units`.)

### Automations

An Orca **automation** matches alerts with a **Sonar query** and runs one or more
**actions** (notify, ticket, remediate). The Sonar query and action list are
complex tool-defined JSON — the official Orca provider itself takes the Sonar
query as a **raw JSON string** — so both are authored here as JSON, matching the
API 1:1 (`filter.sonar_query` and `actions[]`). Status is `enabled`/`disabled`
and an optional business-unit id list scopes it. Automations are the **one** Orca
surface here that publishes a genuine **list** endpoint, so a first deploy with no
prior `rollbackData` additionally resolves identity by a **live name lookup** —
updating an automation created out of band instead of duplicating it. **FLAG:**
each action's numeric `type` code is Orca-internal — copy it from an existing
automation.

### Discovery views (saved user preferences)

An Orca **discovery view** saves a **Discovery (inventory) query** under
`filter_data.query2` so a team can re-run it, with optional display parameters
(`extra_params`) and an `organization_level` sharing flag (share with the whole
org vs. a personal view owned by the API-token user). The server id is
`preference_id`. **FLAG:** `view_type` defaults to `discovery`; other view types
exist in Orca but are unverified for this write path.

### Custom compliance frameworks

An Orca **custom compliance framework** groups **sections**, each containing
**tests** (controls) that map an *existing* Orca rule id to a control
identifier within the framework (e.g. `"1.1"`), via `/api/compliance/frameworks`.
**Sections are write-only** — Orca's read response never echoes them back
(`{ id, display_name, description, custom, active, is_ready }` only), a
limitation the official Terraform provider documents explicitly ("Terraform
cannot detect drift for sections modified outside of Terraform"). This app
follows the same approach: `driftDetect` compares only `name`/`description`,
and `rollback` restores from **this app's own previously-declared body**
(carried forward in `rollbackData`) rather than a live read, since a live read
can never recover a section's contents. The read response also renames `name`
to `display_name` — a genuine write/read asymmetry, not a bug.

### Alert exceptions (built-in system alerts)

An Orca **system (catalog) alert** is predefined and can never be created or
deleted — only its **enabled/disabled** state can be toggled, via
`PUT /api/sonar/rules/status/{rule_id}`. This is the type's whole reason for
being: a declarative **exception** to Orca's default alert catalog. Because the
target already exists in Orca's catalog, identity is the **caller-supplied**
`rule_id` (copied from the Orca Alert Catalog UI) — the one type in this app
with no server-assigned id and no delete branch in rollback (there is nothing
to delete; rollback always restores the prior enabled value).

### Discovery alerts

An Orca **discovery-based custom alert** shares the *same* base resource as
Custom Alerts (`/api/sonar/rules`) but is driven by a **Discovery (graph) JSON
query** (`rule_json`) instead of a Sonar (DSL) string, with an optional
association to one or more custom compliance frameworks (sent as
`compliance_frameworks` in the same create/update call — no extra round trip).
Two verified, honest differences from Custom Alerts: this payload has **no
`enabled` flag** (a discovery alert cannot be toggled through this endpoint,
only edited), and Orca's own Terraform provider always serializes an empty
`negation` field on every request (no `omitempty` on that struct field) — this
app mirrors that for wire fidelity even though its purpose is undocumented.
**Not managed:** `remediation_text` lives behind a *second*, separately-keyed
API (`/api/alerts/custom_remediation_text`, keyed by the server-computed
`rule_type`) rather than the primary create/update body — author it manually
in the Orca UI for now (see Coverage).

### Notification integrations (Jira Cloud / Slack / webhook)

Three distinct Orca UI integrations — **Jira Cloud**, **Slack**, and a
**generic/vendor webhook** (which itself covers Torq, Tines, Opus, Coralogix
and Panther as `type` variants of the same resource) — are all stored under
one API resource, `/api/external_service/config`, discriminated by
`service_name`. This app models them as **one config type** with a `service`
selector, matching the platform's shape. **This is the one Orca resource in
this app whose GET can look a template up by its own human-assigned key**
(`?service_name=&template_name=`), so — unlike every other type here — identity
resolves **live** on every deploy rather than only from `rollbackData`.
**FLAG (verified in the provider's `Update*` methods):** a PUT to Jira or Slack
must **not** include `business_units` — Orca rejects the request with *"You
can't change business units"* — so this app treats it as **create-time only**
for those two services (change it by deleting and recreating the item);
webhook's PUT *does* accept changing it, so this app forwards it on every
webhook update. The webhook `api_key` is treated as write-only for drift and
logging — never compared or displayed — matching this app's other `password`
fields (e.g. `cisco-meraki`'s L7 basic-auth password), even though Orca's own
GET technically echoes it back.

### Custom tag rules

An Orca **custom tag rule** automatically applies one or more **tags**
(key/value pairs) to every asset matching a query, via `/api/custom_tags`. The
query is either a Sonar (DSL) **string** or a discovery **JSON** object,
chosen by `rule_type` — when `json`, the wire body's `rule` field must be the
*parsed* object, not a string, a distinction this type's `_shared.ts` handles
explicitly. **FLAG:** the create response returns only the new id
(`{ data: { tags_rule_id } }`, no echoed body) — the official provider issues a
follow-up GET to confirm the full object; this app does not need that body
immediately, so it skips the extra round trip and lets the *next* deploy's
update path fetch it when needed.

### Custom roles

An Orca **custom role** is a named set of **permission groups** (e.g.
`assets.asset.read`) via `/api/rbac/roles`. This type manages role
**definitions** only — not **assigning** a role to a user or group, which
lives behind a different surface (`/api/rbac/access/{group,user}`) this app
does not manage; see Coverage. **FLAG:** permission-group strings are
Orca-internal and not enumerated by a safely-callable public catalog endpoint
— copy them from an existing role in the Orca UI (Settings > Roles), the same
pattern this app already uses for automation action `type` codes.

### Trusted cloud accounts

A **trusted cloud account** marks a named cloud account (e.g. a vendor's
account with read access into yours) as trusted, via
`/api/organization/trusted_accounts`. Two verified quirks this type's
`_shared.ts` handles explicitly: the id travels as a **query parameter**
(`?id=`) on every operation but create — never a path segment — and **GET
returns an array** even for a single-id lookup (`{ data: [ {...} ] }`), while
POST/PUT return a single object (`{ data: {...} }`) — a genuine asymmetry
between the read and write envelopes.

## Authentication

Orca uses a **long-lived API token** sent in the `Authorization` header with a
`Token ` prefix (**not** `Bearer`):

```
Authorization: Token <api_token>
Content-Type:  application/json
```

This is the exact scheme Orca's own Terraform provider uses, so it is the
verified write path — there is no `api_token → access_token` exchange for this
surface.

Create the token in Orca under **Settings > Users & Permissions > API > Add API
Token** and store it in a Veltrix credential's **API token** field.

### Endpoint (region)

The base URL is a fixed regional endpoint, default **`https://api.orcasecurity.io`**
(US). EU tenants use **`https://api.eu.orcasecurity.io`**. Set it per connection
(the component host) or with the **API Endpoint** app setting.

## Connection test

`GET /api/alerts/catalog/category` — a small authenticated read that proves the
endpoint is reachable and the token is accepted.

## Accuracy / to verify against a live Orca tenant

- The `orca_score` accepted range (this app validates **1–10**; adjust if your
  tenant differs).
- The exact category list (mirrored from Orca's Terraform provider docs).
- The connectivity endpoint `GET /api/alerts/catalog/category`.
- **Business units:** cloud-provider filter values (`alicloud`, `aws`, `azure`,
  `gcp`, `oci`, `shiftleft`) and the tag `key|value` format (vertical bar, not a
  colon).
- **Automations:** the numeric action `type` codes are Orca-internal — copy them
  from an existing automation.
- **Discovery views:** `view_type` values beyond `discovery`.
- **Custom compliance frameworks:** the `checkedKeys` create-only field's
  purpose (undocumented outside the provider source); the framework id (`id`)
  data type across create vs. read.
- **Alert exceptions:** whether every built-in alert accepts `PUT
  .../status/{id}` uniformly, or whether some catalog alerts are
  non-toggleable in your tenant's plan.
- **Discovery alerts:** the `negation` field's actual purpose/effect (sent as
  `""` for wire fidelity with the official provider, but otherwise unverified).
- **Notification integrations:** Jira/Slack OAuth "resource" connections must
  already exist in the Orca UI before a template can reference them; this app
  does not create the OAuth side. The exact `mapping`/`custom_headers` JSON
  shapes are passed through verbatim rather than deep-validated.
- **Custom roles:** the full catalog of valid `permission_groups` strings (no
  safely-callable public list endpoint was identified).
- **Trusted cloud accounts:** whether the numeric `id` can exceed JS's safe
  integer range in practice (treated as a normal `number` here).

## Coverage (v0.3.0)

Coverage was audited against the Orca REST API together with the **official
`orcasecurity/terraform-provider-orcasecurity` source** (the most complete
public description of Orca's write surface — Orca does not publish a full
OpenAPI/REST reference covering every resource the provider exposes). Every
resource below was individually confirmed against the provider's
`api_client/*.go` files and, where one exists, its `docs/resources/*.md` page,
before being scoped in or out.

### Managed as code (11 configuration types)

| Configuration type | Orca resource | Write operations |
| --- | --- | --- |
| Custom Alerts | Custom Sonar rules | Create / read / update / delete |
| Business Units | Filters | Create / read / update / delete |
| Automations | Automations | Create / read / update / delete (+ list, for name-fallback identity) |
| Discovery Views | Saved user preferences | Create / read / update / delete |
| Custom Compliance Frameworks | Compliance frameworks | Create / read (name/description only) / update / delete |
| Alert Exceptions | Built-in system alerts | Read / update (enable/disable) — no create/delete (predefined by Orca) |
| Discovery Alerts | Discovery-based custom alerts | Create / read / update / delete |
| Notification Integrations | Jira Cloud / Slack / webhook templates | Create / read (by name, live) / update / delete |
| Custom Tag Rules | Custom tag rules | Create / read / update / delete |
| Custom Roles | RBAC role definitions | Create / read / update / delete |
| Trusted Cloud Accounts | Trusted cloud accounts | Create / read / update / delete |

Every list-less resource (all but Automations and Notification Integrations)
reconciles by an id this app assigns on create and persists in the
deployment's `rollbackData`, recovered by the stable canvas item id first (so a
rename keeps identity) then by name — the pattern this app has used since
v0.1.0. Two types have a genuinely different reconciliation shape, and each is
called out above and in its own README section: Alert Exceptions (identity is
a caller-supplied `rule_id` of a resource that already exists and can never be
created/deleted) and Notification Integrations (identity resolves live via
Orca's own `(service, template_name)` lookup).

### Confirmed, but intentionally excluded

Each of these was checked against the provider source before being excluded —
this is a "checked and declined," not "not looked at," list.

- **Remediation text** (`custom_remediation_text`, referenced from Discovery
  Alerts). Lives behind a *second*, separately-keyed API tied to the
  server-computed `rule_type` rather than the primary alert create/update
  body — outside the single-transaction model every other write in this app
  follows. Author it manually in the Orca UI.
- **Role/user/group ASSIGNMENT** (`/api/rbac/access/group`,
  `/api/rbac/access/user`, `orcasecurity_group`, `orcasecurity_add_users`).
  Genuinely declarative, but this is identity-bootstrap territory — assigning
  RBAC roles and inviting users — the same category of surface the
  `cisco-meraki` app excludes ("organization-wide administrators ... are
  outside this app's connection boundary"). Custom Roles manages role
  *definitions*; assigning them to people is a platform-identity decision, not
  a CSPM configuration one.
- **Automation priority ordering**
  (`orcasecurity_automation_v2_priority_order`, `PUT
  /api/automations/{id}/priority`). A real, declarative, single-owner ordering
  resource layered on top of Automations (already managed). Excluded from this
  pass for scope — it introduces a second write path (`.../priority`, one
  automation at a time, non-atomic) that would need its own careful
  conflict-with-existing-Automations-item design; a reasonable follow-up, not
  a gap in research.
- **Admission Controller (Kubernetes)** — policies, controls and policy
  assignments (`orcasecurity_admission_controller_{policy,control,policy_assignment}`).
  Genuinely declarative and CRUD-complete, but it is a separate product
  surface (Kubernetes runtime policy enforcement, not cloud/CSPM
  configuration) with its own object graph (templates, cluster scopes,
  enforcement actions) large enough to warrant its own future config-type
  family rather than a rushed single type here.
- **DSPM (data security posture management)** — policies, data detection
  rules and sensitive data identifiers (`orcasecurity_dspm_policy`,
  `orcasecurity_data_detection_rule`, `orcasecurity_sensitive_data_identifier`).
  Same reasoning as Admission Controller: a distinct, CRUD-complete product
  surface (data classification / scanning scope) deserving its own dedicated
  config-type family rather than being squeezed in here.
- **Shift Left (AppSec / CI-CD scanning)** — policies, projects and CVE
  exception lists (`orcasecurity_shift_left_{policy,project,cve_exception_list}`).
  Same reasoning again: a large, CRUD-complete but distinct surface (source
  code / container image / IaC scan policy) that belongs in its own future
  iteration.
- **Custom dashboards and widgets** (`orcasecurity_custom_dashboard`,
  `orcasecurity_custom_widget`). Declarative, but a reporting/visualization
  artifact, not a security-posture configuration — the same category this
  app's Discovery Views already covers the closest legitimate analogue of
  (a saved query), without extending into full dashboard layout authoring.
- **Scheduled reports** (`orcasecurity_scheduled_report`). Declarative, but a
  reporting-delivery artifact (email/Slack/S3/Snowflake export schedules), not
  a security-posture configuration.
- **Dynamic trusted IP range** (`orcasecurity_dynamic_trusted_ip_range`). The
  provider's own schema is a single org-level `{ enabled, org_id }` toggle —
  there is no list of ranges to author, just one boolean. Too thin a surface
  to justify its own config type; revisit if Orca's API grows a real
  IP-range list under this resource.
- **Other `/api/external_service/config` integrations** (Akamai, Azure
  Sentinel, Cloudflare, Monday.com, Opsgenie, PagerDuty, S3 bucket log export,
  ServiceNow ITSM/SIR, Snyk, Splunk, Terraform Cloud, Zscaler ZPA). All ride
  the same base resource Notification Integrations already manages, but each
  has a materially different, vendor-specific config shape and its own
  external-account bootstrap story. Notification Integrations covers the
  three the task's exhaustion criteria named explicitly (Jira/Slack/webhook —
  the last of which alone also covers Torq/Tines/Opus/Coralogix/Panther as
  `type` variants); the remainder are reasonable, honestly-scoped future
  additions to the same config type rather than gaps introduced silently.
- **Add users** (`orcasecurity_add_users`, `POST /api/user_invites`). Sends a
  real invitation email and has no update operation (any change replaces the
  invite) — an onboarding action more than a durable desired-state resource,
  and adjacent to the excluded assignment surface above.

### Read-only / runtime — never in scope

- **Findings, alerts (instances), assets/inventory, vulnerabilities, CDR
  events, audit/system logs, users list.** Runtime/scan output and read-only
  catalogs — nothing here is authored, only observed.
- **Per-alert dismissal/snooze of a specific finding.** A live action on a
  point-in-time finding, not a durable desired-state resource — Orca's own
  "alert dismissal" concept is an *action* an Automation can take
  (`alert_dismissal_details` on an automation), already reachable through this
  app's existing Automations type's free-form `actions` JSON.
- **Live Tools / actions** (agentless scan triggers, cloud-account
  onboarding/scan-status toggles, report generation runs). Imperative
  operations, not declarative configuration.

Primary references: `orcasecurity/terraform-provider-orcasecurity` (GitHub) —
`docs/resources/*.md` plus `orcasecurity/api_client/*.go` for every resource
named above; Orca docs
[custom-alerts](https://docs.orcasecurity.io/docs/custom-alerts) and
[business-unit-feature](https://docs.orcasecurity.io/docs/business-unit-feature).

## Sources

- Orca Terraform provider (authoritative API client): `orcasecurity/terraform-provider-orcasecurity`
  — `orcasecurity/api_client/api_client.go` (auth header), `custom_sonar_alert.go`,
  `business_unit.go`, `automation_v2.go`, `discovery_view.go`,
  `custom_compliance_framework.go`, `system_sonar_alert.go`,
  `custom_discovery_alert.go`, `compliance_section.go`,
  `external_service_config.go`, `jira_cloud_template.go`, `slack_template.go`,
  `webhook_resource.go`, `custom_tag_rule.go`, `custom_role.go`,
  `trusted_cloud_account.go` (endpoints/shape); `business_unit/resource.go` +
  `automation_v2/resource.go` (field enums/validators); `docs/resources/*.md`
  for every managed and excluded resource discussed above.
- Orca docs: <https://docs.orcasecurity.io/docs/custom-alerts>,
  <https://docs.orcasecurity.io/docs/business-unit-feature>
