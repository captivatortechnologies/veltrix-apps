# Auth0 (Veltrix app)

Manage **Auth0** — the Okta-owned enterprise identity platform — as code. Author
Auth0 **Applications (Clients)** in the Configuration Canvas and drive them through
the Security-as-Code pipeline (validate → deploy → health check → drift detection →
rollback) over the **Auth0 Management API v2**.

- **Category:** IAM
- **Component type:** `auth0-tenant`
- **Config types:** `clients` — Applications (Clients)

## How it connects

Auth0 is reached over HTTPS at the tenant's Management API base
`https://<tenant-domain>/api/v2/`. Authentication is a Management API access token
minted per operation via the OAuth2 **client-credentials** grant:

```
POST https://<tenant-domain>/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id=<M2M client id>
client_secret=<M2M client secret>
audience=https://<tenant-domain>/api/v2/
```

The response `access_token` (a Bearer JWT, ~24h lifetime) is then sent as
`Authorization: Bearer <access_token>` on every Management API call.

### Required credential

Create a **Machine to Machine** application in Auth0, authorized for the **Auth0
Management API**, with the scopes:

- `read:clients` — list clients (identity matching, drift, connectivity)
- `create:clients` — create new applications
- `update:clients` — update existing applications
- `delete:clients` — remove applications created by a deploy (rollback)

Store it as a Veltrix connection: **endpoint** = tenant domain (e.g.
`acme.us.auth0.com`), **Client ID** = the M2M application's Client ID, **Client
Secret** = its Client Secret.

## Applications (Clients) config type

Each item is one Auth0 application:

| Field | Auth0 field | Notes |
| --- | --- | --- |
| Name | `name` | Identity for upsert (cannot contain `<`/`>`) |
| Application Type | `app_type` | `spa` \| `native` \| `regular_web` \| `non_interactive` |
| Allowed Callback URLs | `callbacks` | Absolute http(s) URLs (one per line) |
| Allowed Logout URLs | `allowed_logout_urls` | Absolute http(s) URLs (one per line) |
| Allowed Web Origins | `web_origins` | Origins `scheme://host[:port]` (one per line) |
| Token Endpoint Auth Method | `token_endpoint_auth_method` | `none` \| `client_secret_post` \| `client_secret_basic` (blank = Auth0 default) |

### Upsert by name

The Management API keys clients on the server-assigned `client_id`, which does not
exist until a client is created — so this config type upserts by **name**:

1. List the live clients (`GET /api/v2/clients`, paginated).
2. Match one by name.
3. `PATCH /api/v2/clients/{client_id}` if found, else `POST /api/v2/clients`.

`rollbackData` records, per client, the prior managed fields (or `null` when the
client did not exist) and its `client_id`. **Rollback** restores the prior fields,
or `DELETE /api/v2/clients/{client_id}` for a client the deploy created.

## Pipeline handlers

- **validate** — static: name present + free of `<`/`>`, known `app_type` and
  `token_endpoint_auth_method`, absolute http(s) URLs, duplicate-name warning.
- **deploy** — upsert clients by name (see above).
- **rollback** — restore prior fields or delete a created client.
- **healthCheck** — mint a token, then `GET /api/v2/clients?per_page=1`.
- **driftDetect** — compare `app_type`, URL lists and token auth method vs live.
- **getStatus** — deployment status from platform records.

## References

- Management API access tokens (client-credentials):
  https://auth0.com/docs/secure/tokens/access-tokens/management-api-access-tokens/get-management-api-access-tokens-for-production
- Clients — list: https://auth0.com/docs/api/management/v2/clients/get-clients
- Clients — create: https://auth0.com/docs/api/management/v2/clients/post-clients
- Clients — update: https://auth0.com/docs/api/management/v2/clients/patch-clients-by-id
- Clients — delete: https://auth0.com/docs/api/management/v2/clients/delete-clients-by-id
