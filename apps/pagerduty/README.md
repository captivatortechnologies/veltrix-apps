# PagerDuty (Veltrix app)

Manage PagerDuty incident-response configuration as code through the
**PagerDuty REST API v2**. This foundation release (v0.1.0) covers **Escalation
Policies** and drives them through the Security-as-Code pipeline: validate,
deploy, health check, drift detection and rollback.

- **Category:** SOAR
- **API base (fixed):** `https://api.pagerduty.com`
- **Auth:** REST API key — `Authorization: Token token=<key>`
- **Required header:** `Accept: application/vnd.pagerduty+json;version=2`
- **Database / BYOL:** none (pure REST passthrough)

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

## Setup

1. In PagerDuty, create a **REST API key** under **Integrations → API Access
   Keys** (read/write to author policies).
2. Store it as a Veltrix credential in the **API key** field.
3. Register a **pagerduty-account** component and attach the credential. The API
   base is fixed, so the endpoint is only a human-readable label (e.g. the
   account subdomain).
4. Author an **Escalation Policies** configuration in the Configuration Canvas
   and deploy it through the pipeline.

## References

- REST API v2 authentication — https://developer.pagerduty.com/docs/rest-api-v2/authentication/
- Escalation Policies API — https://developer.pagerduty.com/api-reference/ (Create / List / Get / Update / Delete an escalation policy)
