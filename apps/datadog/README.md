# Datadog (Veltrix app)

Manage [Datadog](https://www.datadoghq.com) as code — Security Monitoring
detection rules and suppression rules, Log Management pipelines, and
Monitors — driven by the Veltrix Security-as-Code pipeline (validate → deploy
→ health check → drift detect → rollback).

## What it manages

| Configuration type | Group | Datadog object | API operations |
| --- | --- | --- | --- |
| **Security Monitoring Rules** (`security-monitoring-rules`) | Detection | Detection rules (`log_detection`, `workload_security`, `application_security`, `signal_correlation`, `cloud_configuration`) | `GET /api/v2/security_monitoring/rules` (list), `GET .../{rule_id}` (read), `POST /api/v2/security_monitoring/rules` (create), `PUT .../{rule_id}` (update), `DELETE .../{rule_id}` |
| **Security Monitoring Suppressions** (`security-monitoring-suppressions`) | Detection | Suppression rules (silence signals from matching rules without disabling them) | `GET /api/v2/security_monitoring/configuration/suppressions` (list), `GET .../{id}` (read), `POST .../` (create), `PATCH .../{id}` (update), `DELETE .../{id}` |
| **Log Pipelines** (`log-pipelines`) | Log Management | Log Management pipelines (ordered processor lists) | `GET /api/v1/logs/config/pipelines` (list), `GET .../{pipeline_id}` (read), `POST /api/v1/logs/config/pipelines` (create), `PUT .../{pipeline_id}` (update), `DELETE .../{pipeline_id}` |
| **Monitors** (`monitors`) | Monitors | Alerting monitors | `GET /api/v1/monitor` (list), `GET .../{monitor_id}` (read), `POST /api/v1/monitor` (create), `PUT .../{monitor_id}` (update), `DELETE .../{monitor_id}` |

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

## Authentication

Two **static** keys — no OAuth2 token exchange. Every operation this app
performs, including reads, requires **both**:

- **API Key** (`DD-API-KEY` header) — stored in the credential's **username**
  field.
- **Application Key** (`DD-APPLICATION-KEY` header) — stored in the
  credential's **API token** field. Must belong to a user with permissions
  for everything this app manages — confirmed permission names:
  `security_monitoring_rules_read`, `security_monitoring_rules_write`,
  `security_monitoring_suppressions_read`,
  `security_monitoring_suppressions_write`, `monitors_write`,
  `logs_write_pipelines` — plus standard read access for Monitors and Logs
  Pipelines (the built-in Datadog **Standard** role covers all of the above).

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

**Log Pipelines**
- Create a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/create-a-pipeline/
- Get a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/get-a-pipeline/
- Update a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/update-a-pipeline/
- Delete a pipeline: https://docs.datadoghq.com/api/latest/logs-pipelines/delete-a-pipeline/
- Processors reference: https://docs.datadoghq.com/logs/log_configuration/processors/

**Monitors**
- Overview: https://docs.datadoghq.com/api/latest/monitors/
- Create a monitor: https://docs.datadoghq.com/api/latest/monitors/create-a-monitor/
- Edit a monitor: https://docs.datadoghq.com/api/latest/monitors/edit-a-monitor/
- Delete a monitor: https://docs.datadoghq.com/api/latest/monitors/delete-a-monitor/

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
