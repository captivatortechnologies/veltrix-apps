# Sumo Logic

Manage [Sumo Logic](https://www.sumologic.com/) (cloud SIEM & log analytics) as
code. Author **Field Extraction Rules** in the Configuration Canvas and drive them
through the Veltrix Security-as-Code pipeline — validate, deploy, health check,
drift detection and rollback — over the Sumo Logic **Management API**.

Sumo Logic is SaaS: there is no infrastructure to provision. The app talks to the
public Management API over HTTPS with a valid TLS certificate.

## What it manages

| Configuration type      | Sumo Logic object       | API surface                            |
| ----------------------- | ----------------------- | -------------------------------------- |
| Field Extraction Rules  | Field Extraction Rule   | `/api/v1/extractionRules`              |

A Field Extraction Rule (FER) parses fields from log messages **at ingest time**,
so the parsed fields are available for search, alerts and dashboards without
query-time parsing.

## Authentication

Sumo Logic authenticates with an **Access ID** + **Access Key** pair sent as HTTP
Basic auth on every request:

```
Authorization: Basic base64("<accessId>:<accessKey>")
```

Create a key in the Sumo Logic UI under **Manage → Security → Access Keys** →
_Create New Access Key_. The **Access Key** is displayed only once — copy it
immediately. The key's user/role needs the **Manage Field Extraction Rules** role
capability.

- Access ID → stored as the Veltrix credential's `username`.
- Access Key → stored as the credential's write-only `apiToken` secret.

Docs:
- API auth & endpoints — https://help.sumologic.com/docs/api/about-apis/getting-started/
- Access keys — https://help.sumologic.com/docs/manage/security/access-keys/

## Deployment / base URL

The Management API base URL is **per-deployment**:

```
https://api.<deployment>.sumologic.com/api/v1/
```

US1 uses `api.sumologic.com`; other regions carry the deployment in the host
(e.g. `api.us2.sumologic.com`, `api.eu.sumologic.com`, `api.au.sumologic.com`).
Enter the deployment host as the connection **endpoint** on the Connections page —
the app normalizes it to the `/api/v1` base. See the deployment table:
https://help.sumologic.com/docs/api/getting-started/#which-endpoint-should-i-should-use

## Field Extraction Rules API

Confirmed against the official docs and the SumoLogic Terraform provider client
(`sumologic/sumologic_extraction_rule.go`):

| Operation | Method & path                        | Body / result                                          |
| --------- | ------------------------------------ | ------------------------------------------------------ |
| List      | `GET /api/v1/extractionRules`        | `{ "data": [ ExtractionRule, … ] }`                    |
| Create    | `POST /api/v1/extractionRules`       | body `{ name, scope, parseExpression, enabled }` → created `ExtractionRule` (with `id`) |
| Get       | `GET /api/v1/extractionRules/{id}`   | `ExtractionRule`                                       |
| Update    | `PUT /api/v1/extractionRules/{id}`   | body `{ name, scope, parseExpression, enabled }` (no `id`) |
| Delete    | `DELETE /api/v1/extractionRules/{id}`| —                                                      |

`ExtractionRule` shape:

```jsonc
{
  "id": "0000000000ABCDEF",        // assigned by Sumo Logic (output; omit on write)
  "name": "Parse nginx client IP",  // identity — used to upsert
  "scope": "_sourceCategory=prod/nginx",
  "parseExpression": "parse \"[client=*]\" as client_ip",
  "enabled": true
}
```

Docs — https://www.sumologic.com/help/docs/api/field-extraction-rules/

### Deploy semantics

Rules are **upserted by name**: the deploy handler lists live rules, matches by
name (case-insensitive), then `PUT`s an existing rule or `POST`s a new one. Each
deploy records, per rule, the prior body (or `null` when it created the rule) plus
the rule id, so **rollback** restores the prior body or deletes a rule this deploy
created. **Drift** compares `scope`, `parseExpression` and `enabled` against the
live rule.

## Verify against a live Sumo Logic

The following were reasoned from official docs + the Terraform provider but should
be confirmed against a live tenant before GA:

- **List envelope & pagination.** The list response is `{ data: [...] }`; whether
  it paginates with a `next`/`token` cursor for large rule sets is unconfirmed.
  The list helper reads `data` and tolerates a `next` token defensively.
- **Connectivity probe.** The app uses `GET /api/v1/extractionRules` as its
  reachability + auth check (it also validates the FER read permission).

## Layout

```
apps/sumo-logic/
├── manifest.yaml
├── lib/sumoLogicApi.ts                     # REST client: base URL, Basic auth, request helpers
├── config-types/field-extraction-rules/    # canvas + defaults + full pipeline handlers + tests
├── handlers/testConnection.ts              # connection connectivity test
├── server/index.ts                         # /meta + /settings
└── client/                                 # Overview, Setup Guide, Connections pages
```
