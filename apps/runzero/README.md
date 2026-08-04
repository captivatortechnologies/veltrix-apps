# runZero

Manage [runZero](https://www.runzero.com/) — asset discovery, attack-surface and
network inventory — as code through the Veltrix Security-as-Code pipeline, over the
runZero console REST API (`https://console.runzero.com/api/v1.0`).

## What it manages

| Configuration type | runZero object | Identity | API |
| --- | --- | --- | --- |
| **Sites** | A Site — scan-scope container assets are grouped under | name | `/org/sites` |
| **Scan Tasks** | A recurring scan of a Site | (site, scan name) | `/org/sites/{id}/scan`, `/org/tasks` |
| **Scan Templates** | A reusable, named scan-parameter set | name | `/account/tasks/templates` |
| **Organizations** | A tenant container for sites/assets/scans | name | `/account/orgs` |
| **Users** | A user account, default + per-org roles | email | `/account/users` |
| **Groups** | Bundled default + per-org role assignments | name | `/account/groups` |
| **SSO Group Mappings** | IdP attribute/value → Group | (attribute, value) | `/account/sso/groups` |
| **Asset Ownership Types** | The asset-owner picklist | name | `/account/assets/ownership-types` |
| **Custom Integrations** | A registered asset-data feed's identity | name | `/account/custom-integrations` |
| **Explorer Settings** | An Explorer's site + scan concurrency | Explorer (name/UUID) | `/org/explorers/{id}` |

Every configuration type is authored in the Configuration Canvas and driven through
the pipeline: validate → deploy → health check → drift detection → rollback. See
**Coverage** below for exactly what each type manages, and what's intentionally
excluded.

## Two API scopes

- **Sites, Scan Tasks, Explorer Settings** are **org-scoped** — they live under
  `/org/*` and use an **Organization API key** (`OT…` prefix): `Authorization:
  Bearer <token>`. An Organization key is scoped to a single org and encodes its org
  id, so no org id is supplied separately.
- **Scan Templates, Organizations, Users, Groups, SSO Group Mappings, Asset
  Ownership Types, Custom Integrations** are **account-scoped** — they live under
  `/account/*` and require an **Account API key** (`CT…` prefix). An Organization
  key gets `401`/`403` on these; each type's health check surfaces this plainly.

Both key types are sent the same way (`Authorization: Bearer <token>`) against the
same fixed base URL; only the key's own scope determines which endpoints it can
call. Store whichever key(s) you need as the connection credential's **API key**
field — one connection can hold an account-scoped key if you need both org- and
account-scoped configuration types to work from the same Connection.

## Setup

1. **API key(s)** — in the runZero console (**Account → API keys**), create an
   **Organization API key** for org-scoped types, and/or an **Account API key** for
   account-scoped types (see above).
2. **Connection** — on the app's **Connections** page, add a connection for the
   runZero console (endpoint defaults to `console.runzero.com`) and attach the API
   key. **Test** verifies reachability + authentication via `GET /org/sites`.
3. **Author & deploy** — in the Configuration Canvas, pick a configuration type, add
   items, and deploy.

## Notes

- No database and no BYOL — runZero is a SaaS reached over its REST API.
- No configuration type in this app ever sets or reads a secret/credential value —
  see **Coverage → Intentionally excluded** for why Credentials/API keys/export
  tokens are dropped.

## Development

```
cd apps/runzero
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs runzero                # run handler tests
node ../../scripts/validate-app.mjs apps/runzero         # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was re-audited against the full runZero OpenAPI spec
([runZeroInc/runzero-api](https://github.com/runZeroInc/runzero-api),
`runzero-api.yml`, `info.version: 1.0.5`, fetched 2026-08-04) — every path/operation
was enumerated and classified.

### Managed declarative configuration

| Configuration type | API operations |
| --- | --- |
| Sites | `GET`/`PUT /org/sites`, `PATCH`/`DELETE /org/sites/{id}` |
| Scan Tasks | `PUT /org/sites/{id}/scan`, `GET /org/tasks`, `PATCH`/`POST .../stop /org/tasks/{id}` |
| Scan Templates | `GET`/`POST`/`PUT /account/tasks/templates`, `DELETE /account/tasks/templates/{id}` |
| Organizations | `GET`/`PUT /account/orgs`, `PATCH`/`DELETE /account/orgs/{id}` |
| Users | `GET`/`PUT /account/users`, `PUT /account/users/invite`, `PATCH`/`DELETE /account/users/{id}` |
| Groups | `GET`/`POST`/`PUT /account/groups`, `DELETE /account/groups/{id}` |
| SSO Group Mappings | `GET`/`POST`/`PUT /account/sso/groups`, `DELETE /account/sso/groups/{id}` |
| Asset Ownership Types | batch `GET`/`POST`/`PUT`/`DELETE /account/assets/ownership-types` |
| Custom Integrations | `GET`/`POST /account/custom-integrations`, `PATCH`/`DELETE /account/custom-integrations/{id}` |
| Explorer Settings | `GET /org/explorers`, `PATCH /org/explorers/{id}` (no create/delete) |

Every type upserts by a stable identity (name, email, or a composite key where
noted above) and records enough state in `rollbackData` to undo a create (delete)
or restore an update (write back the prior body).

### Intentionally excluded

- **Hosted zones** (`/org/hosted-zones[/{id}]`) — `GET` only, no write verb exists.
- **Saved queries** — no query-resource endpoint exists anywhere in the API; the
  Queries UI page is not backed by a CRUD API.
- **Rules engine / reports** — no `/org/rules` or `/account/reports` endpoint
  exists; not backed by a CRUD API.
- **Credentials** (`/account/credentials`) and **API keys/export tokens**
  (`/account/keys`, `/account/orgs/{id}/exportTokens`) — these mint/hold/rotate
  secret material; `/account/credentials` has no update verb and never returns the
  secret. A poor upsert/drift fit, and out of scope for declarative config
  regardless.
- **Asset-level tag/owner/criticality writes** (`/org/assets/**`) — these mutate the
  dynamic, scan-discovered asset inventory (matched by asset id or a live search
  query), not a stable named resource with an upsert identity — an imperative
  operation, not durable desired state.
- **User MFA/lockout/password-reset actions**
  (`/account/users/{id}/reset{MFA,Lockout,Password}`) — one-shot account actions,
  not declarative state.
- **Scan data import** (`/org/sites/{id}/import*`), **traffic sampling**
  (`/org/sites/{id}/sample`), and the **legacy Agent paths** (`/org/agents/**` —
  superseded by `/org/explorers/**`, which this app uses) — imperative operations or
  deprecated aliases of an already-managed endpoint.
- Every `/export/**` reporting/export path (assets, services, sites, wireless,
  software, vulnerabilities, certificates, users, groups, findings, tasks, plus the
  Splunk/ServiceNow/Cisco-SNTC integration exports) and `/account/events*` — read-only.

Primary references: [Leveraging the API](https://help.runzero.com/docs/leveraging-the-api/),
[Managing your team](https://help.runzero.com/docs/managing-your-team/), and the
OpenAPI spec at [runZeroInc/runzero-api](https://github.com/runZeroInc/runzero-api).

## Verify against a live runZero

The endpoints and field names above are taken from runZero's official OpenAPI spec.
A few specifics are honestly flagged as unverified beyond the spec's own examples —
see each config type's `_shared.ts` header (notably: the exact `org_default_role`/
`org_roles` wire-value vocabulary in Users/Groups, and the SSO Group Mapping
create-body `id` requirement). Confirm these against a live runZero account before
relying on them in production.
