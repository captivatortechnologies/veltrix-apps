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

## Coverage (v1.3.1)

Coverage was re-audited endpoint-by-endpoint against Tenable's **officially published OpenAPI
catalog** (`developer.tenable.com/openapi/vulnerability-management.json` and
`.../tenable-platform-settings.json`, discovered via the portal's `/.well-known/api-catalog`
linkset) rather than prose docs alone, cross-checked against the **pyTenable** SDK source
(`tenable/io/*.py`) where a method exists. That audit found and fixed three real endpoint/schema
bugs that predate this pass — each is called out below because it changes what "coverage" means
for that type.

### Managed declarative configuration

Each configuration type maps to a durable Tenable object with full create/read/update/delete, so the
pipeline can reconcile desired state against the tenant (drift detection) and roll back cleanly.

| Configuration type | Tenable object | API |
| --- | --- | --- |
| Scans | Scheduled scans (targets, template, recurrence) | `POST`/`GET /scans`, `GET`/`PUT`/`DELETE /scans/{id}` |
| Asset Tags | Category/value tags, static or dynamic | `POST`/`GET /tags/values`, `GET`/`PUT`/`DELETE /tags/values/{uuid}` |
| Exclusions | Scan exclusions / blackout windows | `POST`/`GET /exclusions`, `GET`/`PUT`/`DELETE /exclusions/{id}` |
| Policies | Scan policies (reusable scan templates) | `POST`/`GET /policies`, `GET`/`PUT`/`DELETE /policies/{id}` |
| Networks | Network objects for scanner/asset segmentation | `POST`/`GET /networks`, `GET`/`PUT`/`DELETE /networks/{uuid}` |
| Managed Credentials | Scan credentials (secrets are write-only) | `POST`/`GET /credentials`, `GET`/`PUT`/`DELETE /credentials/{uuid}` |
| Folders | Scan folders | `POST`/`GET /folders`, `PUT`/`DELETE /folders/{id}` |
| Agent Groups | Agent groupings | `POST`/`GET /scanners/{scanner_id}/agent-groups`, `PUT`/`DELETE .../{group_id}` |
| Scanner Groups | Scanner groupings (load-balancing pools) | `POST`/`GET /scanner-groups`, `GET`/`PUT`/`DELETE /scanner-groups/{id}` |
| Agent Exclusions | Agent-scan blackout windows | `POST`/`GET /scanners/{scanner_id}/agents/exclusions`, `PUT`/`DELETE .../{id}` |
| Recast Rules | Severity recast / accept-risk / Host-Audit-result-override rules | `POST /v1/recast/rules/search` (list), `POST /v1/recast/rules`, `GET`/`PUT`/`DELETE /v1/recast/rules/{id}` |
| Asset Attributes | Custom asset-attribute definitions | `POST`/`GET /api/v3/assets/attributes`, `PUT`/`DELETE .../{id}` |
| Cloud Connectors | AWS/Azure/GCP asset connectors (secret-bearing) | `POST`/`GET /settings/connectors`, `GET`/`PUT`/`DELETE .../{id}` |
| Profiles | Agent/scanner performance profiles | `POST`/`GET /sensors/profiles/{sensor_type}`, `GET`/`PUT`/`DELETE .../{profile_uuid}` |
| User Groups | User groups | `POST`/`GET /groups`, `PUT`/`DELETE /groups/{id}` |
| Roles | Custom RBAC roles | `POST`/`GET /access-control/v1/roles`, `GET`/`PUT`/`DELETE .../{uuid}` |
| Permissions | Access-control permission grants (v3) | `POST`/`GET /api/v3/access-control/permissions`, `GET`/`PUT`/`DELETE .../{uuid}` |
| Users | User accounts (identity — often SSO/SCIM-governed) | `POST`/`GET /users`, `GET`/`PUT`/`DELETE /users/{id}`, `PUT /users/{id}/enabled` |

**Identity types (User Groups, Roles, Permissions, Users)** mutate the tenant's access model — treat
them as sensitive. Built-in system roles are read-only; users are commonly governed by an external
IdP (SSO/SCIM), so owning them here can conflict with the IdP.

#### Bugs found and fixed by this audit

- **Profiles** previously called a bare `/profiles` endpoint, which does not exist in Tenable's
  current API — profiles live at `/sensors/profiles/{sensor_type}` (`sensor_type`: `agent` |
  `scanners`; see [profiles-create](https://developer.tenable.com/reference/profiles-create)). The
  config type now requires a Sensor Type field, matches an existing profile within that sensor
  type, and sends the API's real `{ name, description, config }` body (previously it spread the
  freeform settings onto the top level instead of nesting them under `config`).
- **Recast Rules** previously listed rules with `GET /v1/recast/rules`, which has no `GET` method —
  listing requires `POST /v1/recast/rules/search`
  ([recast-rules-search](https://developer.tenable.com/reference/recast-rules-search)). It also
  built `filter` as a flat `{plugin_id, host_targets}` object, but the real API requires
  `{"and"|"or": [{"property","operator","value"}, ...]}`
  ([recast-rules-create](https://developer.tenable.com/reference/recast-rules-create)) — a shape
  the old flat object could never satisfy. It also never sent the rule's name (`rule_name` was
  silently dropped) and had no support for Host Audit rules (`CHANGE_RESULT`/`ACCEPT_RESULT` with
  `compliance_result`), only the Vulnerability/Web-App family (`RECAST`/`ACCEPT` with `severity`,
  and with the wrong, lowercase severity values — the API's enum is `NONE`/`LOW`/`MEDIUM`/`HIGH`/
  `CRITICAL`, case-sensitive). All of the above are fixed; rules now match live state by `rule_name`
  (sent on every deploy) instead of a synthetic tuple, and `comment`, `false_positive` and
  `disabled_details` are also modeled.
- **Policies** called `PUT /policies/{id}/configure` to update a policy. That literal path segment
  does not exist — the correct endpoint is `PUT /policies/{id}` (confirmed against pyTenable's
  `PoliciesAPI.configure()`, whose method name mirrors the *reference page title* "Policies:
  configure", not the URL). Fixed in `deploy.ts`/`rollback.ts`.

### Intentionally excluded

Every candidate below was checked against the same OpenAPI catalog before being dropped — the drop
is a finding, not a gap:

- **Deprecated objects** — Access Groups v1 (`/access-groups`) and v2 (`/v2/access-groups`), and
  Target Groups (`/target-groups`). Tenable deprecated all three on 2022-02-04
  ([access-groups-deprecated](https://developer.tenable.com/docs/access-groups-deprecated),
  [target-groups-deprecated](https://developer.tenable.com/docs/target-groups-deprecated)); use
  Permissions (v3) and Asset Tags instead — both are managed here.
- **"Scheduled Exports"** (`/api/v3/exports/jobs/schedules`) — Tenable's changelog announces a
  durable, CRUD-able scheduled-export object, but as of this audit its reference pages 404 and it
  does not appear anywhere in either currently published OpenAPI spec
  (`vulnerability-management.json`, `tenable-platform-settings.json`). Excluded pending confirmation
  it is part of the current generally-available surface — re-check on the next pass.
- **Jobs, not config** — vulnerability/asset/compliance exports (`/vulns/export`, `/assets/export`,
  `/compliance/export`), scan launch/pause/resume/stop, policy/scan copy & import/export, and report
  generation (`/reports/export`) are one-shot invocations with no durable definition to reconcile.
- **Tenant singletons** — the API-security IP allowlist (`/access-control/v1/api-security-settings`),
  global scanner config (`/scanners/config`) and global agent config (`/scanners/.../agents/config`)
  are update-only settings with no create/delete, so they are not modelled as configuration types.
- **Membership / relationship endpoints** — each type above manages its object's own existence and
  shape; it deliberately does NOT manage that object's membership or assignment to another live
  object: user-group membership (`/groups/{id}/users`), network-to-scanner assignment
  (`/networks/{id}/scanners`), scanner-group membership and routing (`/scanner-groups/{id}/scanners`,
  `/scanner-groups/{id}/routes`), and custom-role-to-user assignment
  (`/access-control/v1/users/{uuid}/roles`). Modelling a relationship between two independently
  round-trippable objects would couple two canvases' identities together and create ambiguous
  ownership on drift; Tenable's console (or a direct API call) is the source of truth for these
  assignments today.
- **Tag categories as a standalone object** (`/tags/categories`) — Tenable auto-creates and describes
  a category as a byproduct of its first tag VALUE (managed here, via `category_name` /
  `category_description`); a bare category rename, or a value-less category, is not modelled
  separately.
- **Legacy object-scoped permissions** (`/permissions/{object_type}/{object_id}`) — superseded by the
  v3 Access-Control Permissions API, which this app manages.
- **Read-only / reference data** — the audit log (used internally for drift attribution — see
  below), the role-permissions catalog, the recast-rule filter-property catalog, the credential-types
  catalog, scan/report filter catalogs, agent safe-mode summary, a scanner's linking key, and
  server status/properties.
- **Secret-bearing one-shot actions** — API-key rotation, 2FA enrollment/verification, and
  password-change-by-id are live security actions, not declarative state.

## Health check

Handlers probe `GET /server/status` — a cheap, read-only call that proves both credential validity
and tenant reachability before doing any work.

## References

- API reference: <https://developer.tenable.com/reference/navigate>
- OpenAPI specs (source of truth for this audit): <https://developer.tenable.com/openapi/vulnerability-management.json>,
  <https://developer.tenable.com/openapi/tenable-platform-settings.json>
- Getting started: <https://developer.tenable.com/docs/welcome>
