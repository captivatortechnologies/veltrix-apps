# authentik (Veltrix app)

Manage [authentik](https://goauthentik.io) (open-source Identity Provider) as
code. Author authentik **Applications**, **OAuth2/OpenID Providers**,
**Groups** and **Flows** in the Configuration Canvas and drive them through the
Security-as-Code pipeline (validate → deploy → health check → drift detection →
rollback) over the **authentik REST API**.

- **Category:** IAM
- **Component type:** `authentik-server` (also accepts `standalone`)
- **Config types:** `applications`, `oauth2-providers`, `groups`, `flows`

## How it connects

authentik is reached over HTTPS at `https://<host>/api/v3/`. Authentication is
a **static API token** — no OAuth exchange, no expiry handled by this app:

```
GET https://<host>/api/v3/core/applications/
Authorization: Bearer <token>
```

The `authentik` OpenAPI security scheme is `{ type: http, scheme: bearer }`.
The token comes from **Directory → Tokens** in authentik (or a Service
account's auto-generated token) and needs permission to manage the resources
below.

A self-hosted authentik instance commonly runs behind a self-signed
certificate, so the transport tolerates an untrusted cert unless the app's
**Verify TLS certificate** setting is turned on.

### Required credential

Store a Veltrix connection with: **endpoint** = the authentik host (e.g.
`authentik.example.com`), **API token** = the token above. No username is
required.

### Identity patterns across config types

authentik resources use two different identity shapes, which changes how each
config type upserts:

| Identity shape | Path key | Config types | Upsert strategy |
| --- | --- | --- | --- |
| User-declared `slug` | `.../{slug}/` (true retrieve-by-identity) | Applications, Flows | `GET {slug}/` → `200` existing / `404` missing → `PATCH`/`POST` |
| Server-assigned id/uuid | `.../{id}/` or `.../{group_uuid}/` | OAuth2/OpenID Providers, Groups | `GET ?name=<name>` (list + exact match) → `PATCH`/`POST` |

The second pattern is handled by the shared `findByName` helper in
`lib/authentikApi.ts` (authentik's `name` list filter narrows server-side;
`findByName` still verifies an exact match client-side, since authentik does
not enforce name-uniqueness on every resource).

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

An authentik Application's `slug` is BOTH its stable identity and its API path
key, so this config type retrieves by identity directly:
`GET /api/v3/core/applications/{slug}/` (`200` existing / `404` missing) →
`PATCH` (partial — a `PatchedApplicationRequest`, so fields this config type
does not author are left untouched) or `POST` (a full `ApplicationRequest`).

**Provider linkage.** `provider` references an **existing** authentik Provider
by its numeric pk — deploy an item in the **OAuth2/OpenID Providers**
configuration type below first (its deploy artifacts expose the created
provider's pk), or reference one created directly in authentik. This config
type does not create providers itself. An invalid/nonexistent pk is rejected
by authentik at deploy time (a `400` surfaced in the deploy error). Provider
kinds other than OAuth2/OpenID (SAML, proxy, LDAP, …) are not yet authorable
here — reference an existing one by pk in the meantime.

## OAuth2/OpenID Providers config type

Each item is one authentik OAuth2/OpenID Provider:

| Field | authentik field | Notes |
| --- | --- | --- |
| Name | `name` | Upsert identity (providers have no user-declared path key) |
| Authorization Flow (UUID) | `authorization_flow` | An existing Flow's UUID **pk** — required |
| Invalidation Flow (UUID) | `invalidation_flow` | An existing Flow's UUID **pk** — required (see note below) |
| Client Type | `client_type` | `confidential` (default) \| `public` |
| Client ID | `client_id` | Optional — blank lets authentik auto-generate one |
| Signing Key (UUID) | `signing_key` | Optional Certificate-Key pair pk |
| Redirect URIs | `redirect_uris` | One URL per line — see note below |
| Scope/Property Mappings (UUIDs) | `property_mappings` | Optional list of Scope Mapping pks |

Unlike Applications/Flows, a provider's API path key is a server-assigned
integer `pk` (`/api/v3/providers/oauth2/{id}/`) — there is no create-time
identity to retrieve by. This config type therefore upserts by **name**:
`GET /api/v3/providers/oauth2/?name=<name>` → exact match → `PATCH .../{pk}/`
(a `PatchedOAuth2ProviderRequest`) or `POST .../` (a full
`OAuth2ProviderRequest`).

- **`client_secret` is never read, sent or captured.** authentik
  generates/rotates it and this config type treats it as write-only, the same
  posture the platform's `wiz` app takes with a generated service-account
  secret. Rotate it in authentik to obtain a usable value.
- **`invalidation_flow` is required by authentik** even though it wasn't in
  the original field list — `OAuth2ProviderRequest.required` is
  `[authorization_flow, invalidation_flow, name, redirect_uris]` per the
  schema, so it's authored here too (a create without it is rejected).
- **Redirect URIs are simplified.** authentik's real `redirect_uris` field is
  an array of `{ matching_mode, url, redirect_uri_type }` objects (strict/regex
  matching, authorization/logout type). This config type authors one URL per
  line as `{ matching_mode: "strict", url, redirect_uri_type: "authorization" }`
  entries — regex matching and logout-type entries are **dropped** from this
  UI for now (edit them directly in authentik if needed).
- **`client_id` / `signing_key` / `property_mappings` are opt-in-managed.**
  Left blank, they are omitted from every request body (both create and
  update), so an auto-generated `client_id`, a default signing behavior, or an
  existing scope-mapping set is left untouched rather than cleared. Drift is
  only asserted for these fields when the canvas item declares a value.
- **Flow references are UUIDs (pk), not slugs.** This matches authentik's own
  foreign-key representation on `OAuth2Provider`. Resolving a Flow's slug
  (this app's own identity for the **Flows** config type below) into its live
  pk automatically is **deferred** — it would need a live options-provider
  lookup (a `remote-select` sourced from `GET /flows/instances/`). For now,
  copy the pk from authentik's admin interface or from a Flow deploy's
  artifacts.

## Groups config type

Each item is one authentik Group:

| Field | authentik field | Notes |
| --- | --- | --- |
| Name | `name` | Upsert identity (groups have no user-declared path key) |
| Superuser group | `is_superuser` | **Caution:** every member becomes an authentik superuser |
| Parent Group (UUID, optional) | `parents` | Single parent — see note below |
| Attributes | `attributes` | Flat key/value map |

Like OAuth2/OpenID Providers, a group's path key is a server-assigned UUID
(`/api/v3/core/groups/{group_uuid}/`), so this config type upserts by **name**.

- **Schema note:** the live field is `parents` (an **array** — authentik
  groups support multiple parents). This config type authors a single optional
  parent for v0.2.0, sent as a one-element array; multi-parent authoring is
  **dropped** for now. Left blank, `parents` is omitted from every request so
  an existing parent set elsewhere is not cleared.
- **Group membership (`users`) and RBAC `roles` are not authored here** — both
  are real, writable `GroupRequest` fields but are **dropped** from every
  request body, so this config type never touches whatever membership/roles
  another admin (or a future config type) has set.

## Flows config type

Each item is one authentik Flow:

| Field | authentik field | Notes |
| --- | --- | --- |
| Name | `name` | Display name |
| Slug | `slug` | Identity for upsert; also the `{slug}` path segment. Pattern `^[-a-zA-Z0-9_]+$` |
| Title | `title` | Shown as the page title while the flow executes |
| Designation | `designation` | `authentication` \| `authorization` \| `invalidation` \| `enrollment` \| `unenrollment` \| `recovery` \| `stage_configuration` — required |
| Required Authentication | `authentication` | Optional access-level gate on running the flow |

Like Applications, a Flow's `slug` is both its identity and its API path key —
this config type retrieves by identity directly: `GET
/api/v3/flows/instances/{slug}/` (`200`/`404`) → `PATCH` (a
`PatchedFlowRequest`, `authentication` only sent when declared) or `POST` (a
full `FlowRequest`).

A deployed flow's UUID `pk` (visible in this app's deploy artifacts, or in
authentik's admin interface) can then be pasted into an OAuth2/OpenID
Provider's Authorization/Invalidation Flow fields.

## Pagination

List reads (`oauth2-providers`, `groups`, and internally by `findByName`) page
through authentik's custom envelope:

```json
{ "pagination": { "next": 2, "previous": null, "count": 42, "current": 1, "total_pages": 3, "start_index": 1, "end_index": 20 },
  "results": [ ... ],
  "autocomplete": { ... } }
```

`pagination.next` / `.previous` are **page numbers** (or a falsy value at the
start/end of the set), not URLs — different from plain DRF's default
`PageNumberPagination`. `lib/authentikApi.ts`'s `listAll` pages via the numeric
`page` query param accordingly; `findByName` layers an exact-name filter on
top of it.

## Pipeline handlers (every config type)

- **validate** — static field/format checks (identity presence + pattern,
  known enum values, UUID-shaped references); no live target access.
- **deploy** — upsert by the type's identity (slug retrieve, or name list +
  match — see table above).
- **rollback** — restore prior managed fields or delete a created resource.
- **healthCheck** — token-authenticated reachability, then per-item existence.
- **driftDetect** — compare managed fields vs. live, per item.
- **getStatus** — deployment status from platform records.

## References

- API overview / browsable API / OpenAPI schema location:
  https://docs.goauthentik.io/developer-docs/api/ (redirects to
  https://api.goauthentik.io/)
- Authentication (bearer token, API token creation):
  https://api.goauthentik.io/authentication/
- OpenAPI v3 schema (fetched directly and grepped for the schemas cited
  throughout this app): https://api.goauthentik.io/schema.yml
  - `Application` / `ApplicationRequest` / `PatchedApplicationRequest` /
    `PaginatedApplicationList` / `Pagination` / `PolicyEngineMode`
  - `OAuth2Provider` / `OAuth2ProviderRequest` / `PatchedOAuth2ProviderRequest` /
    `RedirectURI` / `RedirectURIRequest` / `MatchingModeEnum` /
    `RedirectURITypeEnum` / `ClientTypeEnum`
  - `Group` / `GroupRequest` / `PatchedGroupRequest`
  - `Flow` / `FlowRequest` / `PatchedFlowRequest` / `FlowDesignationEnum` /
    `AuthenticationEnum`
- Applications — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/core-applications-list,
  core-applications-create, core-applications-retrieve,
  core-applications-partial-update, core-applications-destroy
- OAuth2/OpenID Providers — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/providers-oauth2-list,
  providers-oauth2-create, providers-oauth2-retrieve,
  providers-oauth2-partial-update, providers-oauth2-destroy
- Groups — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/core-groups-list, core-groups-create,
  core-groups-retrieve, core-groups-partial-update, core-groups-destroy
- Flows — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/flows-instances-list,
  flows-instances-create, flows-instances-retrieve,
  flows-instances-partial-update, flows-instances-destroy

## Development

```
cd apps/authentik
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs authentik      # run handler tests
node ../../scripts/validate-app.mjs apps/authentik   # validate against the app contract
```
