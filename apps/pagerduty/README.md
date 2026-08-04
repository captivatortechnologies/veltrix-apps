# PagerDuty (Veltrix app)

Manage PagerDuty incident-response configuration as code through the
**PagerDuty REST API v2**, driven through the Security-as-Code pipeline:
validate, deploy (upsert by name), health check, drift detection and rollback.
See **Coverage** below for the full list of what is (and, honestly, isn't)
managed and why.

- **Category:** SOAR
- **API base (fixed):** `https://api.pagerduty.com`
- **Auth:** REST API key — `Authorization: Token token=<key>`
- **Required header:** `Accept: application/vnd.pagerduty+json;version=2`
- **Database / BYOL:** none (pure REST passthrough)

## Coverage

Twelve configuration types are implemented, each reconciled by a stable
identity and driven through the full pipeline (validate / deploy / rollback /
health check / drift detect):

| Configuration type | Identity | Endpoint |
| --- | --- | --- |
| Escalation Policies | name | `/escalation_policies` |
| Services | name | `/services` |
| Schedules | name | `/schedules` |
| Teams | name | `/teams` |
| Users | email | `/users` |
| Business Services | name | `/business_services` |
| Event Orchestrations | name | `/event_orchestrations` |
| Service Orchestrations | target service name | `/event_orchestrations/services/{id}` |
| Extensions | name | `/extensions` |
| Webhook Subscriptions | description | `/webhook_subscriptions` |
| Tags | label | `/tags` |
| Automation Actions | name | `/automation_actions/actions` |

### Excluded — Automation Actions Runners

**Not implemented, and not planned as a standalone config type.** A PagerDuty
Automation Actions runner comes in two flavors, and neither has a safe,
complete creation path through the public API:

- **`runbook`** — the only runner type the API can actually create
  (`POST /automation_actions/runners`) — requires a `runbook_api_key`
  (a Runbook Automation API token) embedded **directly in the plain JSON
  request body**. This app's Credential Vault model never stores a secret
  outside the Vault to hand it to a third-party API in cleartext, so this app
  will not create one.
- **`sidecar`** — a self-hosted runner that self-registers with PagerDuty when
  its agent is installed; it **cannot be created through the REST API at all**.

With no type this app can honestly create from a blank canvas, "reconciled by
name, create on first deploy" — the contract every other config type in this
app provides — cannot be met. See the official Terraform provider's resource
docs, which state outright: *"Only Runbook Automation (runbook) runners can be
created."* —
[`pagerduty_automation_actions_runner`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/website/docs/r/automation_actions_runner.html.markdown).
An Automation Action can still *reference* an existing runner (created via the
PagerDuty UI, or by another tool) by name — see the Automation Actions section
below.

### Excluded — Service Integrations

**Not implemented, and not planned as a standalone config type.** Every other
config type in this app reconciles a canvas item against the live account by
LISTING the collection and matching a declared item by name — an idempotent,
stateless upsert that works correctly even on a first deploy to a fresh
account. PagerDuty's Service Integrations API has no equivalent: there is no
`GET /services/{id}/integrations` list endpoint. An integration can only be
read back (`GET /services/{id}/integrations/{integration_id}`) using an id the
caller already knows — there is no supported way to ask "does an integration
named X already exist under this service?"

The official Terraform provider confirms this is a real API gap, not an
oversight in this app: its
[`pagerduty_service_integration`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/pagerduty/resource_pagerduty_service_integration.go)
resource never searches for an existing integration by name — `Read` only
works because Terraform itself already stored the id in state at `Create`
time. This app's deploy has no equivalent persistent store to consult on a
fresh account; without one, every declarative deploy risks creating a
duplicate integration instead of reconciling the one already there. A "clean"
config type here would require either accepting that risk or building a
name-to-id mapping this app has to maintain and trust forever — a materially
weaker (and different) reconciliation guarantee than every other type in this
app provides. Rather than force it in, this app leaves service integrations to
be managed directly in the PagerDuty UI (or with a tool, like Terraform, that
owns persistent per-resource state).

## What it manages

### Escalation Policies (`escalation-policies`)

A PagerDuty escalation policy applied over `/escalation_policies` and reconciled
by its **name**. Each canvas item declares one policy:

| Field | Notes |
| --- | --- |
| `name` | Required. The reconciliation identity (upsert + drift match). |
| `description` | Optional. |
| `num_loops` | Optional non-negative integer — how many times the chain repeats when unacknowledged. |
| `escalation_rules` | Required JSON array. Each rule is `{ "escalation_delay_in_minutes": <minutes>, "targets": [ { "type": "user_reference" \| "schedule_reference", "id": "<id>" } ] }`. At least one rule, each with at least one target. |

Example `escalation_rules` value:

```json
[
  { "escalation_delay_in_minutes": 30, "targets": [ { "type": "schedule_reference", "id": "PWXYZ12" } ] },
  { "escalation_delay_in_minutes": 30, "targets": [ { "type": "user_reference", "id": "PABC123" } ] }
]
```

### Automation Actions (`automation-actions`)

A PagerDuty Automation Actions action applied over
`/automation_actions/actions` and reconciled by its **name**. Each canvas item
declares one action:

| Field | Notes |
| --- | --- |
| `name` | Required. The reconciliation identity (upsert + drift match). |
| `description` | Required — the PagerDuty API rejects a new action without one. |
| `action_type` | Required: `script` or `process_automation`. **Immutable once set** — PagerDuty rejects changing it; a redeploy that tries fails with a clear error rather than silently deleting and recreating the action. |
| `action_data` | Required JSON object; shape depends on `action_type`. `script`: `{ "script": "...", "invocation_command": "..." }` (`script` required). `process_automation`: `{ "process_automation_job_id": "...", "process_automation_job_arguments": "...", "process_automation_node_filter": "..." }` (`process_automation_job_id` required). |
| `runner` | Optional NAME of an existing runner, resolved to an id at deploy. **Not managed by this app** — see Coverage. |
| `action_classification` | Optional: `diagnostic` or `remediation`. |
| `teams` / `services` | Optional JSON arrays of NAMES, resolved to ids and associated via `POST .../teams` / `.../services`. **Additive only** — a name removed from the canvas is never detached on redeploy (same restraint as the Tags config type's assignments). |
| `map_to_all_services` | Optional boolean; when true, `services` is ignored and the action applies to every service. |
| `only_invocable_on_unresolved_incidents` / `allow_invocation_manually` / `allow_invocation_from_event_orchestration` | Optional invocation-rule booleans. |

Example `action_data` values:

```json
{ "script": "systemctl restart web", "invocation_command": "/bin/bash" }
```

```json
{ "process_automation_job_id": "P123456", "process_automation_job_arguments": "--flag value" }
```

## API surface used

| Operation | Call |
| --- | --- |
| List (reconcile / drift / health) | `GET /escalation_policies` → `{ escalation_policies: [...] }` |
| Create | `POST /escalation_policies` ← `{ escalation_policy: {...} }` |
| Update | `PUT /escalation_policies/{id}` ← `{ escalation_policy: {...} }` |
| Delete (rollback of a created policy) | `DELETE /escalation_policies/{id}` |
| Connectivity test | `GET /abilities` |

The deploy handler **upserts by name**: it lists the live policies, updates a
matching one by id (`PUT`) or creates a new one (`POST`). Rollback restores an
updated policy's prior body or deletes a newly created one.

Automation Actions uses the same upsert-by-name shape, but is CURSOR-paginated
(`next_cursor`, not `limit`/`offset`) and needs three extra calls for its
optional references and associations:

| Operation | Call |
| --- | --- |
| List (reconcile / drift / health) | `GET /automation_actions/actions` → `{ actions: [...], next_cursor }` |
| Read one (association detail before diffing) | `GET /automation_actions/actions/{id}` → `{ action: {...} }` |
| Create | `POST /automation_actions/actions` ← `{ action: {...} }` |
| Update | `PUT /automation_actions/actions/{id}` ← `{ action: {...} }` |
| Delete (rollback of a created action) | `DELETE /automation_actions/actions/{id}` |
| Resolve `runner` (name → id, read-only) | `GET /automation_actions/runners` → `{ runners: [...], next_cursor }` |
| Associate / dissociate a team | `POST` / `DELETE /automation_actions/actions/{id}/teams[/{team_id}]` ← `{ team: { id, type: "team_reference" } }` |
| Associate / dissociate a service | `POST` / `DELETE /automation_actions/actions/{id}/services[/{service_id}]` ← `{ service: { id, type: "service_reference" } }` |

## Setup

1. In PagerDuty, create a **REST API key** under **Integrations → API Access
   Keys** (read/write to author policies).
2. Store it as a Veltrix credential in the **API key** field.
3. Register a **pagerduty-account** component and attach the credential. The API
   base is fixed, so the endpoint is only a human-readable label (e.g. the
   account subdomain).
4. Author any of the configuration types listed in **Coverage** in the
   Configuration Canvas and deploy it through the pipeline.

## References

- REST API v2 authentication — https://developer.pagerduty.com/docs/rest-api-v2/authentication/
- Escalation Policies API — https://developer.pagerduty.com/api-reference/ (Create / List / Get / Update / Delete an escalation policy)
- Automation Actions API — https://developer.pagerduty.com/api-reference/d64584a4371d3-create-an-automation-action
- Automation Actions Runner API — https://developer.pagerduty.com/api-reference/d78999fb7e863-create-an-automation-action-runner
- `terraform-provider-pagerduty` (cross-checked wire shapes + the Coverage exclusions above): https://github.com/PagerDuty/terraform-provider-pagerduty
  - [`resource_pagerduty_automation_actions_action.go`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/pagerduty/resource_pagerduty_automation_actions_action.go) / [`automation_actions_action.html.markdown`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/website/docs/r/automation_actions_action.html.markdown)
  - [`resource_pagerduty_automation_actions_runner.go`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/pagerduty/resource_pagerduty_automation_actions_runner.go) / [`automation_actions_runner.html.markdown`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/website/docs/r/automation_actions_runner.html.markdown)
  - [`resource_pagerduty_service_integration.go`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/pagerduty/resource_pagerduty_service_integration.go) / [`vendor/.../go-pagerduty/service_integration.go`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/vendor/github.com/PagerDuty/go-pagerduty/service_integration.go)
  - [`vendor/.../heimweh/go-pagerduty/automation_actions_action.go`](https://github.com/PagerDuty/terraform-provider-pagerduty/blob/master/vendor/github.com/heimweh/go-pagerduty/pagerduty/automation_actions_action.go) (confirms the bare-string `runner` wire field and the team/service association endpoints)
