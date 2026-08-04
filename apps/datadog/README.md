# Datadog (Veltrix app)

Manage [Datadog](https://www.datadoghq.com) as code — Security Monitoring
rules/suppressions/filters, Sensitive Data Scanner (DLP), Log Management
(pipelines/archives/metrics/indexes), Monitors, SLOs and RBAC Roles — driven
by the Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | Group | Datadog object | API operations |
| --- | --- | --- | --- |
| **Security Monitoring Rules** (`security-monitoring-rules`) | Detection | Detection rules (`log_detection`, `workload_security`, `application_security`, `signal_correlation`, `cloud_configuration`) | `GET /api/v2/security_monitoring/rules` (list), `GET .../{rule_id}` (read), `POST /api/v2/security_monitoring/rules` (create), `PUT .../{rule_id}` (update), `DELETE .../{rule_id}` |
| **Security Monitoring Suppressions** (`security-monitoring-suppressions`) | Detection | Suppression rules (silence signals from matching rules without disabling them) | `GET /api/v2/security_monitoring/configuration/suppressions` (list), `GET .../{id}` (read), `POST .../` (create), `PATCH .../{id}` (update), `DELETE .../{id}` |
| **Security Filters** (`security-filters`) | Detection | Filters that exclude matching logs from security analysis entirely | `GET /api/v2/security_monitoring/configuration/security_filters` (list), `GET .../{id}` (read), `POST` (create), `PATCH .../{id}` (update), `DELETE .../{id}` |
| **Sensitive Data Scanner** (`sensitive-data-scanner`) | Data Security | DLP scanning groups + their scanning rules | `GET /api/v2/sensitive-data-scanner/config` (whole graph), `POST/PATCH/DELETE .../config/groups[/{id}]`, `POST/PATCH/DELETE .../config/rules[/{id}]` |
| **Log Pipelines** (`log-pipelines`) | Log Management | Log Management pipelines (ordered processor lists) | `GET /api/v1/logs/config/pipelines` (list), `GET .../{pipeline_id}` (read), `POST /api/v1/logs/config/pipelines` (create), `PUT .../{pipeline_id}` (update), `DELETE .../{pipeline_id}` |
| **Log Archives** (`log-archives`) | Log Management | Cold-storage log archives (S3/GCS/Azure) | `GET /api/v2/logs/config/archives` (list), `GET .../{archive_id}` (read), `POST` (create), `PUT .../{archive_id}` (update), `DELETE .../{archive_id}` |
| **Log-Based Metrics** (`log-metrics`) | Log Management | Custom metrics generated from logs | `GET /api/v2/logs/config/metrics` (list), `GET .../{metric_id}` (read), `POST` (create), `PATCH .../{metric_id}` (update), `DELETE .../{metric_id}` |
| **Log Indexes** (`log-indexes`) | Log Management | Retention/quota/exclusion for indexed logs | `GET /api/v1/logs/config/indexes` (list), `GET .../{name}` (read), `POST` (create), `PUT .../{name}` (update), `DELETE .../{name}` |
| **Monitors** (`monitors`) | Monitors | Alerting monitors | `GET /api/v1/monitor` (list), `GET .../{monitor_id}` (read), `POST /api/v1/monitor` (create), `PUT .../{monitor_id}` (update), `DELETE .../{monitor_id}` |
| **SLOs** (`slos`) | Monitors | Service Level Objectives (metric- or monitor-based) | `GET /api/v1/slo` (list), `GET .../{slo_id}` (read), `POST` (create), `PUT .../{slo_id}` (update), `DELETE .../{slo_id}` |
| **Roles** (`roles`) | Access | RBAC roles + their permission grants | `GET /api/v2/roles` (list), `GET .../{role_id}` (read), `POST` (create), `PATCH .../{role_id}` (update), `DELETE .../{role_id}`, plus `GET/POST/DELETE .../{role_id}/permissions` |

Every config type reconciles by **name** (case-insensitive) and targets a
`datadog-org` component.

### Rule types and the shared schema

`log_detection`, `workload_security` and `application_security` rules share
the standard shape — one or more `queries` (a search string plus an
aggregation), one or more `cases` (a severity `status` plus an optional
trigger `condition`), and `options` (evaluation window, keep-alive, max signal
duration, detection method). This app deep-validates that shape: every query
needs a `query` string; `aggregation` / `dataSource`, when set, must be a
supported value; every case needs a supported `status`; the window options,
when set, must be one of Datadog's fixed set of second values.

`signal_correlation` rules reference other rules by id instead of a search
query, and `cloud_configuration` rules carry a Rego compliance policy in
`options.complianceRuleOptions` instead of a query, and take **exactly one**
case (its `status` is the finding's severity). Because these two types'
`queries` / `options` shapes diverge structurally from the standard rules and
from each other, this app applies only light, JSON-shape validation to their
type-specific parts (plus the universal `cases[].status` check) — Datadog's
own API is the final arbiter of those sub-schemas. Anything this app does not
model is passed straight through to Datadog.

### Updates are optimistic-concurrency controlled

A rule update (`PUT`) must include a `version` matching the rule's current
version. Before every update, this app re-reads the live rule to capture its
current `version` (and its full prior body, for rollback) immediately before
writing — and, on rollback, re-reads it again to get the version current at
restore time, rather than reusing the value captured at deploy time.

### Filters

Every rule may optionally declare `filters` — additional queries that
`require` or `suppress` matched events before they are processed. Defaults to
an empty array when not needed.

### Security Monitoring Suppressions

A suppression rule silences signals from detection rules matching its
`rule_query` that also match its `suppression_query` — without disabling the
underlying rule. Unlike Security Monitoring Rules, this is a **JSON:API**
resource (`{"data":{"type":"suppressions","attributes":{...}}}`) at
`/api/v2/security_monitoring/configuration/suppressions`, and its update
verb is `PATCH`, documented as a true partial update. This app always sends
every managed attribute on `PATCH`, so each deploy still fully replaces the
declared state. A live suppression whose `attributes.editable` is `false` is
protected — this app never modifies it.

**Correction vs. a `/api/v2/security_monitoring/suppressions` guess:** the
verified path has a `configuration/` segment —
`/api/v2/security_monitoring/configuration/suppressions`.

### Log Pipelines

A pipeline is an ordered list of `processors` (grok parsers, remappers,
enrichers, …) applied to logs matching an optional `filter.query`. Datadog
documents 17 processor types; this app validates only the common envelope
per processor (`type` from the documented enum, `is_enabled` boolean) and
passes each type's own fields straight through to Datadog's API — see
[Log Processors](https://docs.datadoghq.com/logs/log_configuration/processors/)
for their individual schemas.

**Protected:** a live pipeline matching a declared name that is
Datadog-managed (`is_read_only: true`, e.g. a built-in "nginx"/"apache"
integration pipeline) is never modified — the deploy fails loudly.

**Not managed (flagged, not faked):** pipeline **order** is a separate
singleton resource (`GET`/`PUT /api/v1/logs/config/pipeline-order`), distinct
from the per-pipeline CRUD endpoints above. This app does not manage it — a
newly created pipeline is appended by Datadog and may need manual reordering
in the Datadog UI (Logs → Pipelines) if it needs to run ahead of an existing
pipeline.

**Unverified, flagged:** the dedicated "list pipelines" doc page returned a
404 during research. The list endpoint is modeled as returning a plain JSON
array — consistent with the v1 API's flat (non-JSON:API) convention confirmed
for get/create/update, and with other v1 list endpoints (e.g.
`GET /api/v1/monitor`) — with a defensive unwrap in `lib`-style code in case
it is instead wrapped.

### Monitors

Monitors are name/type/query/message/options. Update (`PUT`) is a full
replace. Delete never passes Datadog's optional `force=true` — a rollback or
reconcile that would delete a monitor still referenced by an SLO or composite
monitor fails with a clear error instead of forcing the deletion through.

**Unverified, flagged — `type` enum:** research surfaced roughly 15-20
monitor type values across the docs and the Terraform provider, but could not
fully confirm the complete, authoritative list against one source (and at
least one pass omitted `metric alert`, the best-established classic monitor
type). Rather than risk rejecting a legitimate type this research missed,
`type` is a free-text field; validate.ts only **warns** when it doesn't match
the well-documented common set — Datadog's own API is the final arbiter and
will reject a truly invalid type.

### Sensitive Data Scanner (DLP)

Datadog's DLP config is a JSON:API relationship graph: ONE org-wide
"configuration" singleton owns many scanning **groups**, each owning many
scanning **rules**. This app models one canvas item = one group, with the
group's rules authored as a nested JSON array (a rule needs exactly one of a
custom `pattern` (regex) or a `standard_pattern_id` — Datadog's built-in
pattern library, `GET .../config/standard-patterns`). Rules are **fully
synced** to what's declared: a live rule in the group that's no longer in the
array is deleted on the next deploy.

**Not managed (flagged, not faked):** group/rule **ordering** is a separate
`PATCH /api/v2/sensitive-data-scanner/config` reorder operation on the
org-wide configuration singleton — out of scope for this release, matching
the same ordering exclusion applied to Log Pipelines/Indexes below.

### Log Archives

An archive routes matching logs to a customer-owned S3/GCS/Azure destination
through a cloud integration **already configured** in Datadog — every
`destination` field is a non-secret identifier (a bucket/container name, an
IAM role name, a service-account email, an AAD client id), never a
credential; the actual credential material lives in Datadog's separately
configured AWS/GCP/Azure integration, entirely outside this app's scope.

**Not managed (flagged, not faked):** archive **order** (`GET`/`PUT
/api/v2/logs/config/archive-order`) and reader-role grants (`.../{id}/readers`)
are separate resources — out of scope for this release.

### Log-Based Metrics

A metric's `id` **is** its name — chosen once at creation and used as the
permanent URL path key ever after, unlike every other resource in this app
which has a separate server-assigned id. This app therefore reconciles by a
**direct lookup** (`GET .../{id}`; 404 means absent) rather than list+match.
`compute.aggregation_type` and `compute.path` are documented as **create-only**
(present in the response model, absent from the update request model) — this
app never sends them on `PATCH`, only the mutable fields (`filter`,
`group_by`, `compute.include_percentiles`). Changing either requires manually
deleting and recreating the metric — this app does not automate that
delete/recreate cycle, since a fresh metric_id breaks continuity with the
metric's own history.

### Log Indexes

Like Log-Based Metrics, an index's `name` **is** its permanent identity (the
URL path key), so this is a direct lookup, not list+match. Update (`PUT`) is
a full replace.

**Not managed (flagged, not faked):** index **order** (`GET`/`PUT
/api/v1/logs/config/index-order`) — a separate singleton that decides which
index a log lands in FIRST when more than one index's filter could match —
is out of scope for this release. Per-index retention/quota/exclusion-filter
configuration is fully declarative on its own regardless of ordering; a
newly created index is appended by Datadog and may need manual reordering to
take effect ahead of an existing one.

### SLOs

Supports both `metric` (a numerator/denominator query pair) and `monitor`
(uptime of one or more existing monitor ids, optionally scoped by `groups`)
SLOs, each with one or more timeframe `thresholds`. `time_slice` (a newer
third SLO type) is accepted but not deep-validated — this app's research did
not turn up a confirmed request-body reference for it, so it is passed
through to Datadog's API as authored rather than faked. Delete never passes a
force flag — a rollback/reconcile that would delete an SLO still referenced
elsewhere fails with a clear error instead of forcing it through.

### Roles (RBAC)

Permissions are authored by **name** (e.g. `monitors_write`) and resolved to
Datadog's opaque permission ids via `GET /api/v2/permissions` at deploy time;
an unrecognized name fails the deploy with a clear error.

**ADDITIVE ONLY — this app never revokes a permission.** Datadog's
create-role reference documents that several read permissions (Dashboards,
Notebooks, Monitors, APM, Vulnerability Management, RUM Apps, Incidents,
SLOs, CI Visibility, CD Visibility — all "Read") are **automatically added to
every new role**, whether or not they're in the request. A full grant/revoke
sync (the pattern this same codebase uses for Auth0 roles) would fight that
baseline set on every deploy — either the revoke is rejected (breaking every
role deploy) or it succeeds and silently strips baseline UI access Datadog
itself treats as a role's floor. This app therefore only **grants** declared
permissions that aren't already present; removing a permission from a role
is left to the Datadog UI. Drift detection matches this: a MISSING declared
permission is reported, but an extra live one (a baseline default, or one a
human granted directly) never is.

## Coverage

Every writable, declarative Datadog config surface this app's research could
verify against the official API reference is now managed, with the full
validate/deploy/rollback/healthCheck/driftDetect/getStatus handler set:

- Security Monitoring detection rules — `/api/v2/security_monitoring/rules[/{rule_id}]`
- Security Monitoring suppression rules — `/api/v2/security_monitoring/configuration/suppressions[/{id}]`
- Security Monitoring security filters — `/api/v2/security_monitoring/configuration/security_filters[/{id}]`
- Sensitive Data Scanner groups + rules — `/api/v2/sensitive-data-scanner/config/{groups,rules}[/{id}]`
- Log Management pipelines — `/api/v1/logs/config/pipelines[/{pipeline_id}]`
- Log Management archives — `/api/v2/logs/config/archives[/{archive_id}]`
- Log-based metrics — `/api/v2/logs/config/metrics/{metric_id}`
- Log Management indexes — `/api/v1/logs/config/indexes/{name}`
- Monitors — `/api/v1/monitor[/{monitor_id}]`
- SLOs — `/api/v1/slo[/{slo_id}]`
- RBAC roles + permission grants (additive-only) — `/api/v2/roles[/{role_id}]` + `.../permissions`

**Intentionally excluded, with why:**

- **Ordering singletons** — pipeline order (`.../logs/config/pipeline-order`),
  archive order (`.../logs/config/archive-order`), index order
  (`.../logs/config/index-order`), and the Sensitive Data Scanner group/rule
  reorder (`PATCH .../sensitive-data-scanner/config`). Each per-resource CRUD
  surface above is independently declarative and useful without ordering; a
  newly created resource is appended by Datadog and may need manual
  reordering. Consistent, flagged treatment across every affected type.
- **Archive reader-role grants** (`.../logs/config/archives/{id}/readers`) —
  a separate relationship resource; out of scope for this release.
- **Downtimes** (`/api/v2/downtime`) — DROPPED, not built. A downtime (even a
  recurring one with an `rrule`) is a time-bound operational ACTION — mute a
  monitor's alerting for a window — not a durable config object with a
  stable "current state" to diff and reconcile the way a rule or monitor
  definition is. More importantly, this app's rollback model reverts a
  config to its prior full state; an automated rollback silently
  re-enabling a monitor's alerting during a human-declared incident/
  maintenance window is a genuine operational-safety risk this app declines
  to take on.
- **Datadog-managed built-ins / read-only resources** — a Log Pipeline
  marked `is_read_only`, a Suppression marked `editable: false`, and (best
  effort, unverified field name) a Security Filter marked `is_builtin` are
  matched-but-protected: this app refuses to modify them rather than
  silently failing or corrupting them.
- **API keys, Application keys, and cloud/SaaS integration setup**
  (`/api/v2/api_keys`, `/api/v2/application_keys`, AWS/GCP/Azure/Slack/
  PagerDuty/webhook integration configuration) — this IS credential/secret
  material (or the exchange flow for it); an app managing the very secrets
  it authenticates with, or third-party webhook URLs/tokens, is out of
  scope by design.
- **User, team and service-account administration** (`/api/v2/users`,
  `/api/v2/teams`) — identity-lifecycle/invite concerns that typically
  belong to the customer's IdP/SCIM provisioning, not a security/
  observability config-as-code surface.
- **Dashboards, Notebooks, Synthetics tests, Incidents, On-Call, Workflows,
  Cases** — legitimate Datadog config-as-code surfaces (some, like
  Synthetics, have mature Terraform support) but out of scope for this
  release: dashboards/notebooks are large, deeply nested widget trees
  poorly suited to this app's flat canvas-item model, and the
  incident/on-call/workflow/case surfaces are operational-process tools
  more than static configuration. Candidates for a future release.
- **Cloud Security Management posture rules** — already covered: this is
  the `cloud_configuration` type of Security Monitoring Rules
  (`security-monitoring-rules`), not a separate surface.
- **Read-only / operational-telemetry surfaces** — Audit Trail, Usage &
  Cost Attribution, Events, Security Signals, Findings, and log
  ingestion/ingest-pipeline runtime data. These are queried, not declared;
  nothing to reconcile.

No empty declaration, stub handler, or guessed request shape is shipped for
anything listed as excluded above — each is a deliberate, documented scope
decision, not an oversight.

## Authentication

Two **static** keys — no OAuth2 token exchange. Every operation this app
performs, including reads, requires **both**:

- **API Key** (`DD-API-KEY` header) — stored in the credential's **username**
  field.
- **Application Key** (`DD-APPLICATION-KEY` header) — stored in the
  credential's **API token** field. Must belong to a user with permissions
  for everything this app manages. Permission names this app's research
  directly confirmed against Datadog's docs: `security_monitoring_rules_read`,
  `security_monitoring_rules_write`, `security_monitoring_suppressions_read`,
  `security_monitoring_suppressions_write`, `security_monitoring_filters_write`
  (`_read` inferred by the established naming convention, unconfirmed),
  `monitors_write` (`monitors_read` likewise inferred), `logs_write_pipelines`,
  `logs_modify_indexes`, `data_scanner_write` (`data_scanner_read` inferred),
  `user_access_read` (to resolve permission names to ids for Roles). Grant the
  built-in Datadog **Admin** role (or the specific permissions above plus
  standard read/write for Log Archives, Log-Based Metrics, SLOs and Roles —
  Organization Settings → Roles has the current, authoritative list) rather
  than guess every exact string.

Create both in Datadog under **Organization Settings → API Keys** /
**→ Application Keys**.

## Component — the Datadog site

Register a `datadog-org` component whose **hostname holds your Datadog SITE**
(not a URL) — e.g. `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`,
`us5.datadoghq.com`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`.
Requests go to `https://api.<site>` — the same server template
([`https://{subdomain}.{site}`](https://github.com/DataDog/datadog-api-client-typescript/blob/master/packages/datadog-api-client-common/servers.ts),
subdomain `api`) Datadog's own official API clients use, so a Datadog site
added after this app was built still works without an update. Site reference:
https://docs.datadoghq.com/getting_started/site/. An empty/unset site falls
back to `datadoghq.com` (US1).

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for calls to the Datadog API. |

## API references

**Security Monitoring Rules**
- Overview: https://docs.datadoghq.com/api/latest/security-monitoring/
- Get a rule's details: https://docs.datadoghq.com/api/latest/security-monitoring/get-a-rules-details/
- Create a detection rule: https://docs.datadoghq.com/api/latest/security-monitoring/create-a-detection-rule/
- Update an existing rule: https://docs.datadoghq.com/api/latest/security-monitoring/update-an-existing-rule/
- Terraform provider schema (cross-check): https://registry.terraform.io/providers/DataDog/datadog/latest/docs/resources/security_monitoring_rule

**Security Monitoring Suppressions**
- Get all suppression rules: https://docs.datadoghq.com/api/latest/security-monitoring/get-all-suppression-rules/
- Get a suppression rule: https://docs.datadoghq.com/api/latest/security-monitoring/get-a-suppression-rule/
- Create a suppression rule: https://docs.datadoghq.com/api/latest/security-monitoring/create-a-suppression-rule/
- Update a suppression rule: https://docs.datadoghq.com/api/latest/security-monitoring/update-a-suppression-rule/
- Delete a suppression rule: https://docs.datadoghq.com/api/latest/security-monitoring/delete-a-suppression-rule/

**Security Monitoring Filters**
- Get all filters: https://docs.datadoghq.com/api/latest/security-monitoring/get-all-security-filters/
- Get a filter: https://docs.datadoghq.com/api/latest/security-monitoring/get-a-security-filter/
- Create: https://docs.datadoghq.com/api/latest/security-monitoring/create-a-security-filter/
- Update: https://docs.datadoghq.com/api/latest/security-monitoring/update-a-security-filter/
- Delete: https://docs.datadoghq.com/api/latest/security-monitoring/delete-a-security-filter/

**Sensitive Data Scanner**
- Overview: https://docs.datadoghq.com/api/latest/sensitive-data-scanner/
- Create a scanning group: https://docs.datadoghq.com/api/latest/sensitive-data-scanner/create-scanning-group/
- Create a scanning rule: https://docs.datadoghq.com/api/latest/sensitive-data-scanner/create-scanning-rule/
- List scanning groups (config graph shape): https://docs.datadoghq.com/api/latest/sensitive-data-scanner/list-scanning-groups/

**Log Pipelines**
- Create a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/create-a-pipeline/
- Get a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/get-a-pipeline/
- Update a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/update-a-pipeline/
- Delete a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/delete-a-pipeline/
- Processors reference: https://docs.datadoghq.com/logs/log_configuration/processors/

**Log Archives**
- Overview: https://docs.datadoghq.com/api/latest/logs-archives/
- Create an archive: https://docs.datadoghq.com/api/latest/logs-archives/create-an-archive/

**Log-Based Metrics**
- Overview: https://docs.datadoghq.com/api/latest/logs-metrics/
- Create a log-based metric: https://docs.datadoghq.com/api/latest/logs-metrics/create-a-log-based-metric/
- Update a log-based metric: https://docs.datadoghq.com/api/latest/logs-metrics/update-a-log-based-metric/

**Log Indexes**
- Overview: https://docs.datadoghq.com/api/latest/logs-indexes/
- Create an index: https://docs.datadoghq.com/api/latest/logs-indexes/create-an-index/
- Update an index: https://docs.datadoghq.com/api/latest/logs-indexes/update-an-index/

**Monitors**
- Overview: https://docs.datadoghq.com/api/latest/monitors/
- Create a monitor: https://docs.datadoghq.com/api/latest/monitors/create-a-monitor/
- Edit a monitor: https://docs.datadoghq.com/api/latest/monitors/edit-a-monitor/
- Delete a monitor: https://docs.datadoghq.com/api/latest/monitors/delete-a-monitor/

**SLOs**
- Overview: https://docs.datadoghq.com/api/latest/service-level-objectives/

**Roles**
- Overview: https://docs.datadoghq.com/api/latest/roles/
- Create a role: https://docs.datadoghq.com/api/latest/roles/create-role/
- Grant a permission to a role: https://docs.datadoghq.com/api/latest/roles/grant-permission-to-a-role/
- List permissions: https://docs.datadoghq.com/api/latest/roles/list-permissions/

**Excluded surfaces (cited for completeness)**
- Downtimes (v2): https://docs.datadoghq.com/api/latest/downtimes/

**Shared**
- Validate API key: https://docs.datadoghq.com/api/latest/authentication/validate-api-key/
- API and Application keys: https://docs.datadoghq.com/account_management/api-app-keys/
- Datadog sites: https://docs.datadoghq.com/getting_started/site/

## Development

```
cd apps/datadog
node node_modules/typescript/bin/tsc --noEmit    # typecheck
node ../../scripts/test-apps.mjs datadog         # run handler tests
node ../../scripts/validate-app.mjs apps/datadog # validate against the app contract
```
