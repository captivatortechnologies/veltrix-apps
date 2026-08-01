# Orca Security (Veltrix app)

Manage [Orca Security](https://orca.security) (agentless CNAPP / CSPM)
configuration as code through the **Orca REST API**, driven by the Veltrix
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

As of **v0.2.0** it manages four configuration types (custom alerts, business
units, automations and discovery views).

## What it manages

| Configuration type | Orca object | REST endpoints |
| --- | --- | --- |
| **Custom Alerts** (`custom-alerts`) | Custom Sonar rules | `POST /api/sonar/rules`, `GET/PUT/DELETE /api/sonar/rules/{id}` |
| **Business Units** (`business-units`) | Filters | `POST /api/filters`, `GET/PUT/DELETE /api/filters/{id}` |
| **Automations** (`automations`) | Automations | `POST /api/automations`, `GET/PUT/DELETE /api/automations/{id}`, `GET /api/automations?limit=&start_at_index=` (list) |
| **Discovery Views** (`discovery-views`) | Saved user preferences | `POST /api/user_preferences`, `GET/PUT/DELETE /api/user_preferences/{id}` |

Every configuration type targets an `orca-tenant` component and reconciles by the
server id it **assigns on create and persists** in the deployment's
`rollbackData` (recovered by the stable canvas item id first — supporting rename
— then by name). The shared, network-free reconciliation helpers live in
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

## Sources

- Orca Terraform provider (authoritative API client): `orcasecurity/terraform-provider-orcasecurity`
  — `orcasecurity/api_client/api_client.go` (auth header), `custom_sonar_alert.go`,
  `business_unit.go`, `automation_v2.go`, `discovery_view.go` (endpoints/shape),
  `business_unit/resource.go` + `automation_v2/resource.go` (field enums/validators).
- Orca docs: <https://docs.orcasecurity.io/docs/custom-alerts>,
  <https://docs.orcasecurity.io/docs/business-unit-feature>
