# Orca Security (Veltrix app)

Manage [Orca Security](https://orca.security) (agentless CNAPP / CSPM)
configuration as code through the **Orca REST API**, driven by the Veltrix
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

This is the **v0.1.0 foundation** — one configuration type (custom alerts).

## What it manages

| Configuration type | Orca object | REST endpoints |
| --- | --- | --- |
| **Custom Alerts** (`custom-alerts`) | Custom Sonar rules | `POST /api/sonar/rules` (create), `GET /api/sonar/rules/{id}` (read), `PUT /api/sonar/rules/{id}` (update), `DELETE /api/sonar/rules/{id}` (delete) |

The configuration type targets an `orca-tenant` component.

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

## Sources

- Orca Terraform provider (authoritative API client): `orcasecurity/terraform-provider-orcasecurity`
  — `orcasecurity/api_client/api_client.go` (auth header), `custom_sonar_alert.go` (endpoints/shape).
- Orca docs: <https://docs.orcasecurity.io/docs/custom-alerts>
