# Changelog

All notable changes to the authentik app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-02

Three new configuration types, plus a sidebar `group` on every configuration
type (including 0.1.0's Applications, now `group: "Applications"`). All reuse
`lib/authentikApi.ts` unchanged (the Bearer client + the page-number pager).
BYOL infrastructure for authentik is **not** part of this release — config
types only.

- **OAuth2/OpenID Providers (`oauth2-providers`, group "Providers").** Manage
  authentik OAuth2/OpenID Providers — name, authorization/invalidation flow (by
  Flow UUID pk), client type/id, signing key, redirect URIs and scope
  (property) mappings — over `/api/v3/providers/oauth2/`. Unlike Applications,
  a provider's API path key is a server-assigned integer `pk` with no
  create-time identity, so this type upserts by **name** (list `?name=` →
  exact match → `PATCH`/`POST`) via a new shared `findByName` helper added to
  `lib/authentikApi.ts`. This **unblocks the Applications → Provider linkage**
  flagged in 0.1.0: deploy a provider here, then paste its pk into an
  Application's `provider` field.
  - `client_secret` is never read, sent, or captured — treated as write-only,
    the same posture the platform's `wiz` app takes with a generated secret.
  - `invalidation_flow` is authored even though it wasn't in the original spec
    — the schema's `OAuth2ProviderRequest.required` includes it; a create
    without it is rejected by authentik.
  - Redirect URIs are authored as one URL per line, translated to authentik's
    real `{ matching_mode: "strict", url, redirect_uri_type: "authorization" }`
    shape — regex matching and logout-type entries are **dropped** from the UI
    for v0.2.0.
  - `client_id` / `signing_key` / `property_mappings` are opt-in-managed: left
    blank they are omitted from every request (never cleared), and drift is
    only asserted for them when declared.
  - Flow references are authored as the target Flow's **UUID pk**, not its
    slug — matching authentik's own FK representation. Live resolution from a
    Flow's slug (its own identity in this app's Flows type) is **flagged** as
    a follow-up (a `remote-select` sourced from `GET /flows/instances/`).
- **Groups (`groups`, group "Directory").** Manage authentik Groups — name,
  the superuser flag, an optional parent group and custom attributes — over
  `/api/v3/core/groups/`. Also upserts by name (server-assigned UUID path key).
  - The live field is `parents` (an array); this release authors a single
    optional parent, sent as a one-element array only when declared —
    multi-parent authoring is **dropped** for now.
  - Group membership (`users`) and RBAC `roles` are real `GroupRequest` fields
    that are **dropped** from every request body — this type never touches
    membership or role assignment.
- **Flows (`flows`, group "Flows").** Manage authentik Flows — name, slug,
  title, designation and an optional required-authentication level — over
  `/api/v3/flows/instances/`. Like Applications, a flow's `slug` is both its
  identity and API path key, so this type retrieves by identity directly
  (`GET .../{slug}/` → `200`/`404` → `PATCH`/`POST`).
- All three types ship the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus) and full `__tests__` coverage of
  validate + the pure `_shared.ts` helpers (network-free, matching the 0.1.0
  test style).
- Client: Setup Guide now covers all four configuration types and their token
  scopes; Overview is unchanged (generic, fed by `/meta`).

> Cited against `https://api.goauthentik.io/schema.yml` (fetched directly);
> see the README's References section for the exact schema names and endpoint
> reference pages per config type.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Applications** config type — create / edit / delete authentik Applications
  (name, slug, an optional bound provider by existing pk, policy engine mode,
  UI group and display metadata) over the authentik Core REST API
  (`/api/v3/core/applications/`), with validate / deploy (upsert by slug,
  retrieved directly via `GET .../applications/{slug}/`) / rollback (restore
  prior managed fields or delete a created application) / health-check /
  drift-detect / status.
- **Connectivity test** — verifies the endpoint + a static API token with
  `GET /api/v3/core/applications/?page_size=1`, `Authorization: Bearer <token>`.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API
  token → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a self-hosted authentik instance; saving a
  connection registers `authentik-server` as a deploy target).

> authentik authenticates with a single static API token (no OAuth exchange) —
> the connection stores it as the credential's API token; no username is
> required. A self-hosted instance's self-signed certificate is tolerated
> unless the app's `verify_tls` setting is turned on.

> **Provider linkage deferred.** `provider` references an existing authentik
> Provider (OAuth2/OIDC, SAML, proxy, LDAP, …) by numeric pk — this release
> does not create or manage Providers themselves. That ships as its own
> configuration type in a later wave; an invalid/nonexistent pk is rejected by
> authentik at deploy time.
