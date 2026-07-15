# Tenable Vulnerability Management

Manage [Tenable Vulnerability Management](https://www.tenable.com/products/tenable-io) (tenable.io)
configuration as code through the Tenable VM REST API. Author configurations in the platform's
Configuration Canvas and deploy them through the Security-as-Code pipeline — validate, deploy,
health check, drift detection and rollback are handled per configuration type.

## Credentials

The app authenticates every request with an API key pair, sent as
`X-ApiKeys: accessKey=…; secretKey=…` — there is no login step. Create a key pair in Tenable under
**Settings → My Account → API Keys**, then store it as a Veltrix credential:

| Veltrix credential field | Tenable value |
| --- | --- |
| Username | Access key |
| API token | Secret key |

Register a **`tenable-vm-tenant`** component and attach the credential. Leave the hostname blank to
use the global endpoint (`cloud.tenable.com`); set it only for a dedicated or FedRAMP host.

## What it manages

Each configuration type maps to a durable Tenable object with full create/read/update/delete, so the
pipeline can reconcile desired state against the tenant (drift detection) and roll back cleanly.

| Configuration type | Tenable object | API |
| --- | --- | --- |
| Scans | Scheduled scans (targets, template, recurrence) | `/scans` |
| Asset Tags | Category/value tags, static or dynamic | `/tags/values` |
| Exclusions | Scan exclusions / blackout windows | `/exclusions` |
| Policies | Scan policies (reusable scan templates) | `/policies` |
| Networks | Network objects for scanner/asset segmentation | `/networks` |
| Managed Credentials | Scan credentials (secrets are write-only) | `/credentials` |
| Folders | Scan folders | `/folders` |
| Agent Groups | Agent groupings | `/scanners/{id}/agent-groups` |
| Scanner Groups | Scanner groupings | `/scanner-groups` |
| Agent Exclusions | Agent-scan blackout windows | `/scanners/{id}/agent-exclusions` |
| Recast Rules | Severity recast / accept-risk rules | `/v1/recast/rules` |
| Asset Attributes | Custom asset-attribute definitions | `/api/v3/assets/attributes` |
| Cloud Connectors | AWS/Azure/GCP asset connectors (secret-bearing) | `/settings/connectors` |
| Profiles | Scanner/agent performance profiles | `/profiles` |
| User Groups | User groups | `/groups` |
| Roles | Custom RBAC roles | `/access-control/v1/roles` |
| Permissions | Access-control permission grants (v3) | `/api/v3/access-control/permissions` |
| Users | User accounts (identity — often SSO/SCIM-governed) | `/users` |

**Identity types (User Groups, Roles, Permissions, Users)** mutate the tenant's access model — treat
them as sensitive. Built-in system roles are read-only; users are commonly governed by an external
IdP (SSO/SCIM), so owning them here can conflict with the IdP.

### Not covered, on purpose

- **Deprecated objects** — Access Groups (v1/v2) and Target Groups. Tenable deprecated both; use
  Permissions and Asset Tags instead (both of which this app manages).
- **Jobs, not config** — vulnerability/asset/compliance exports, report generation, scan launches
  and bulk operations are one-shot invocations with no durable definition to reconcile.
- **Tenant singletons** — the API-security IP allowlist and agent/scanner config are update-only
  settings (no create/delete), so they are not modelled as configuration types.

## Health check

Handlers probe `GET /server/status` — a cheap, read-only call that proves both credential validity
and tenant reachability before doing any work.

## References

- API reference: <https://developer.tenable.com/reference/navigate>
- Getting started: <https://developer.tenable.com/docs/welcome>
