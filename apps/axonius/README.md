# Axonius

Manage **Axonius** — CAASM (Cyber Asset Attack Surface Management) — as code on the
Veltrix Security-as-Code platform. This foundation release manages Axonius **saved
queries**: reusable asset views defined by a named [AQL][aql] filter over the
`devices` or `users` module plus the columns to display.

Author saved queries in the Configuration Canvas and drive them through the
pipeline — **validate → deploy → health check → drift detect → rollback** — over
the Axonius REST API.

## What it manages

| Configuration type | What it does |
| --- | --- |
| **Saved Queries** (`saved-queries`) | Create / update / delete Axonius saved queries for the `devices` and `users` modules — name, AQL filter and display columns. Upsert is keyed on the `(module, name)` pair. |

## Connecting to Axonius

Axonius authenticates the REST API with a **service-account API key + secret**
(required on Axonius 6.1.74+; earlier versions allow a regular user account). Get
them from your account page (gear icon → **My Account**, or
`https://<tenant>/account`).

On the **Connections** page, add a connection:

- **Endpoint** — your Axonius tenant host, its HTTPS address on 443
  (e.g. `tenant.axonius.com`).
- **API key** — stored as the credential username.
- **API secret** — stored as the credential token.

Use **Test** to verify reachability and authentication (`GET
api/settings/meta/about`). Saving the connection also registers the tenant as a
deploy-target component (`componentType: axonius`).

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `verify_tls` | `false` | Enforce a valid TLS certificate. Off by default because on-prem Axonius often ships a self-signed cert; turn on for a cloud tenant. |
| `api_version` | `""` | Optional REST API version segment inserted after `/api/` (e.g. `V4.0` → `/api/V4.0/...`). Blank uses the unversioned `/api/` root. |

## API surface used

All calls are HTTPS (443) with `api-key` + `api-secret` request headers and JSON:API
bodies (`Content-Type: application/vnd.api+json`).

| Operation | Method + path |
| --- | --- |
| Connectivity / health | `GET api/settings/meta/about` |
| List saved queries | `GET api/queries/saved?page[limit]=2000&page[offset]=0` |
| Create saved query | `POST api/queries/{devices\|users}` |
| Update saved query | `PUT api/queries/{uuid}` |
| Delete saved query | `DELETE api/queries/query/{uuid}` |

Create/update body (JSON:API):

```json
{ "data": { "type": "views_schema", "attributes": {
  "name": "Windows servers",
  "view": { "query": { "filter": "(specific_data.data.os.type == \"Windows\")" },
            "fields": ["specific_data.data.hostname", "specific_data.data.name"] },
  "description": "", "tags": [], "private": false, "always_cached": false, "asset_scope": false
}}}
```

> **Verify against a live Axonius tenant.** Endpoint paths and shapes follow the
> public [`axonius-api-client`][client] (unversioned `api/...`). Some tenants expose
> a versioned root (`/api/V4.0/`) — set the `api_version` setting if so.

## Development

```bash
# from the repo root
npm run validate apps/axonius        # manifest + canvas + bundle checks
npm test axonius                     # run the app's __tests__
cd apps/axonius && npx tsc --noEmit  # typecheck
```

No database and no BYOL — this app is a thin, API-driven configuration manager.

[aql]: https://docs.axonius.com/docs/axonius-query-language-aql
[client]: https://github.com/Axonius/axonius_api_client
