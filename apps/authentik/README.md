# authentik (Veltrix app)

Manage [authentik](https://goauthentik.io) (open-source Identity Provider) as
code. Author authentik **Applications** in the Configuration Canvas and drive
them through the Security-as-Code pipeline (validate → deploy → health check →
drift detection → rollback) over the **authentik Core REST API**.

- **Category:** IAM
- **Component type:** `authentik-server` (also accepts `standalone`)
- **Config types:** `applications` — Applications

## How it connects

authentik is reached over HTTPS at `https://<host>/api/v3/`. Authentication is
a **static API token** — no OAuth exchange, no expiry handled by this app:

```
GET https://<host>/api/v3/core/applications/
Authorization: Bearer <token>
```

The `authentik` OpenAPI security scheme is `{ type: http, scheme: bearer }`.
The token comes from **Directory → Tokens** in authentik (or a Service
account's auto-generated token) and needs permission to manage applications.

A self-hosted authentik instance commonly runs behind a self-signed
certificate, so the transport tolerates an untrusted cert unless the app's
**Verify TLS certificate** setting is turned on.

### Required credential

Store a Veltrix connection with: **endpoint** = the authentik host (e.g.
`authentik.example.com`), **API token** = the token above. No username is
required.

## Applications config type

Each item is one authentik Application:

| Field | authentik field | Notes |
| --- | --- | --- |
| Name | `name` | Display name |
| Slug | `slug` | Identity for upsert; also the `{slug}` path segment. Pattern `^[-a-zA-Z0-9_]+$` |
| Provider (pk) | `provider` | Numeric pk of an **existing** provider — see below |
| Policy Engine Mode | `policy_engine_mode` | `any` (OR, default) \| `all` (AND) |
| UI Group | `group` | Groups the tile on the user's My Applications page |
| Description | `meta_description` | Shown on the application's tile |
| Publisher | `meta_publisher` | Shown on the application's tile |

### Upsert by slug

Unlike some IdPs whose write API keys objects on a server-assigned id, an
authentik Application's `slug` is BOTH its stable identity and its API path
key. This config type can therefore retrieve by identity directly:

1. `GET /api/v3/core/applications/{slug}/` — `200` existing, `404` missing.
2. `PATCH /api/v3/core/applications/{slug}/` (partial — a `PatchedApplicationRequest`) if found,
   else `POST /api/v3/core/applications/` (a full `ApplicationRequest`, including `slug`).

`PATCH` only ever carries the fields this config type manages, so fields it
does **not** author (`meta_launch_url`, `open_in_new_tab`, `meta_hide`,
`backchannel_providers`, …) are left untouched on an existing application.

`rollbackData` records, per application, the prior managed fields (or `null`
when it did not exist) and whether it existed. **Rollback** restores the prior
fields via `PATCH`, or `DELETE /api/v3/core/applications/{slug}/` for an
application this deploy created.

### Provider linkage — deferred to a later wave

`provider` references an **existing** authentik Provider (OAuth2/OIDC, SAML,
proxy, LDAP, …) by its numeric pk. This release does **not** create or manage
Providers — the operator must create the provider in authentik first and
supply its pk here. Managing Providers as their own configuration type is
planned for a later wave; until then, an invalid/nonexistent pk is rejected by
authentik itself at deploy time (a `400` surfaced in the deploy error).

### Pagination

List reads page through authentik's custom envelope:

```json
{ "pagination": { "next": 2, "previous": null, "count": 42, "current": 1, "total_pages": 3, "start_index": 1, "end_index": 20 },
  "results": [ ... ],
  "autocomplete": { ... } }
```

`pagination.next` / `.previous` are **page numbers** (or a falsy value at the
start/end of the set), not URLs — different from plain DRF's default
`PageNumberPagination`. `lib/authentikApi.ts`'s `listAll` pages via the numeric
`page` query param accordingly.

## Pipeline handlers

- **validate** — static: name + slug required, slug pattern, known
  `policy_engine_mode`, positive-integer `provider` when set, duplicate-slug
  warning.
- **deploy** — upsert applications by slug (see above).
- **rollback** — restore prior managed fields or delete a created application.
- **healthCheck** — token-authenticated reachability, then per-application
  existence.
- **driftDetect** — compare managed fields vs. live, per application.
- **getStatus** — deployment status from platform records.

## References

- API overview / browsable API / OpenAPI schema location:
  https://docs.goauthentik.io/developer-docs/api/ (redirects to
  https://api.goauthentik.io/)
- Authentication (bearer token, API token creation):
  https://api.goauthentik.io/authentication/
- OpenAPI v3 schema (Application / ApplicationRequest / PatchedApplicationRequest /
  PaginatedApplicationList / Pagination / PolicyEngineMode):
  https://api.goauthentik.io/schema.yml
- Applications — list/create:
  https://api.goauthentik.io/reference/core-applications-list,
  https://api.goauthentik.io/reference/core-applications-create
- Applications — retrieve/update/delete:
  https://api.goauthentik.io/reference/core-applications-retrieve,
  https://api.goauthentik.io/reference/core-applications-partial-update,
  https://api.goauthentik.io/reference/core-applications-destroy

## Development

```
cd apps/authentik
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs authentik      # run handler tests
node ../../scripts/validate-app.mjs apps/authentik   # validate against the app contract
```
