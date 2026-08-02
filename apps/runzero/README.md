# runZero

Manage [runZero](https://www.runzero.com/) — asset discovery, attack-surface and
network inventory — as code through the Veltrix Security-as-Code pipeline. This
v0.1.0 foundation manages runZero **Sites**: the scan-scope containers that
discovered assets are grouped under.

## What it manages

| Configuration type | runZero object | API |
| --- | --- | --- |
| **Sites** | A Site — name, description, default scan scope (subnets/CIDRs) | `/org/sites` |

Each Site is authored in the Configuration Canvas and driven through the pipeline:
validate → deploy → health check → drift detection → rollback. Sites are upserted by
**name** (the stable identity).

## API

- **Base URL:** `https://console.runzero.com/api/v1.0` (fixed for the hosted
  platform; a self-hosted runZero Platform install sets its own host as the
  connection endpoint).
- **Auth:** an **Organization API key** (OT… prefix), sent as a Bearer token —
  `Authorization: Bearer <token>`. An Organization key is scoped to a single
  organization and encodes its org id, so no org id is supplied separately.
- **Sites endpoints:**
  - `GET /org/sites` — list all sites (also used as the connectivity / health probe)
  - `PUT /org/sites` — **create** a site (SiteOptions body)
  - `GET /org/sites/{id}` — get one site
  - `PATCH /org/sites/{id}` — update a site
  - `DELETE /org/sites/{id}` — delete a site and its assets
- **SiteOptions (create/update body):** `name` (required), `description`, `scope`.
  The canvas exposes the scan scope as a **subnets** textarea (CIDRs/hosts, one per
  line); it maps to the API `scope` string.

> Docs: [Leveraging the API](https://help.runzero.com/docs/leveraging-the-api/),
> [Sites](https://help.runzero.com/docs/sites/), and the OpenAPI spec at
> [runZeroInc/runzero-api](https://github.com/runZeroInc/runzero-api).

## Setup

1. **API key** — in the runZero console, create an **Organization API key** under
   **Account → API keys** for the target organization.
2. **Connection** — on the app's **Connections** page, add a connection for the
   runZero console (endpoint defaults to `console.runzero.com`) and attach the API
   key. **Test** verifies reachability + authentication via `GET /org/sites`.
3. **Author & deploy** — in the Configuration Canvas, pick **Sites**, add your sites
   (name, description, subnets), and deploy.

## Notes

- No database and no BYOL — runZero is a SaaS reached over its REST API.
- runZero also exposes **Account API keys** (CT… prefix) for account-level operations
  (creating orgs/users). This app uses an **Organization** key for the `/org` endpoints.

## Verify against a live runZero

The endpoints and field names above are taken from runZero's official API docs and
the `runzero-api` / `runzero-api-go` OpenAPI definitions. Confirm the exact
`GET /org/sites` response envelope (bare array vs. a wrapped object) and the
create/update verbs (`PUT` create, `PATCH` update) against a live runZero
organization before relying on them in production.
