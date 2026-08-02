# Datadog (Veltrix app)

Manage [Datadog](https://www.datadoghq.com) **Security Monitoring** detection
rules as code through the **Security Monitoring Rules API**, driven by the
Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detect → rollback).

## What it manages

| Configuration type | Datadog object | API operations |
| --- | --- | --- |
| **Security Monitoring Rules** (`security-monitoring-rules`) | Detection rules (`log_detection`, `workload_security`, `application_security`, `signal_correlation`, `cloud_configuration`) | `GET /api/v2/security_monitoring/rules` (list), `GET .../{rule_id}` (read), `POST /api/v2/security_monitoring/rules` (create), `PUT .../{rule_id}` (update), `DELETE .../{rule_id}` |

Reconciles by **rule name** (case-insensitive) and targets a `datadog-org`
component.

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

## Authentication

Two **static** keys — no OAuth2 token exchange. Every Security Monitoring
Rules operation, including reads, requires **both**:

- **API Key** (`DD-API-KEY` header) — stored in the credential's **username**
  field.
- **Application Key** (`DD-APPLICATION-KEY` header) — stored in the
  credential's **API token** field. Must belong to a user with the
  `security_monitoring_rules_read` and `security_monitoring_rules_write`
  permissions.

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

- Security Monitoring Rules: https://docs.datadoghq.com/api/latest/security-monitoring/
- Get a rule's details: https://docs.datadoghq.com/api/latest/security-monitoring/get-a-rules-details/
- Create a detection rule: https://docs.datadoghq.com/api/latest/security-monitoring/create-a-detection-rule/
- Update an existing rule: https://docs.datadoghq.com/api/latest/security-monitoring/update-an-existing-rule/
- Validate API key: https://docs.datadoghq.com/api/latest/authentication/validate-api-key/
- API and Application keys: https://docs.datadoghq.com/account_management/api-app-keys/
- Datadog sites: https://docs.datadoghq.com/getting_started/site/
- Terraform provider schema (cross-check): https://registry.terraform.io/providers/DataDog/datadog/latest/docs/resources/security_monitoring_rule

## Development

```
cd apps/datadog
node node_modules/typescript/bin/tsc --noEmit    # typecheck
node ../../scripts/test-apps.mjs datadog         # run handler tests
node ../../scripts/validate-app.mjs apps/datadog # validate against the app contract
```
