# authentik (Veltrix app)

Manage [authentik](https://goauthentik.io) (open-source Identity Provider) as
code. Author authentik **Applications**, **Providers** (OAuth2/OpenID, SAML,
Proxy, LDAP), **Groups**, **Flows & Stages**, **Scope Property Mappings**,
**Policies**, **Sources** (OAuth, LDAP) and **Brands** in the Configuration
Canvas and drive them through the Security-as-Code pipeline (validate → deploy
→ health check → drift detection → rollback) over the **authentik REST API** —
and optionally have Veltrix host the authentik stack itself via **BYOL
infrastructure provisioning**.

- **Category:** IAM
- **Component type:** `authentik-server` (also accepts `standalone`)
- **Config types (12):** `applications`, `oauth2-providers`, `saml-providers`,
  `proxy-providers`, `ldap-providers`, `groups`, `flows`, `stages`,
  `scope-property-mappings`, `policies`, `sources`, `brands`
- **BYOL:** Server + Worker node tiers, PostgreSQL (no Redis — see below)
- See **Coverage** below for what's managed vs. intentionally excluded, and
  why.

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
| User-declared `slug` | `.../{slug}/` (true retrieve-by-identity) | Applications, Flows, Sources | `GET {slug}/` → `200` existing / `404` missing → `PATCH`/`POST` |
| Server-assigned id/uuid, matched by `name` | `.../{id}/` or `.../{uuid}/` | OAuth2/OpenID, SAML, Proxy, LDAP Providers, Groups, Scope Property Mappings, Policies, Stages | `GET ?name=<name>` (list + exact match) → `PATCH`/`POST` |
| Server-assigned uuid, matched by another field | `.../{brand_uuid}/` | Brands (matched by `domain`) | `GET ?domain=<domain>` (list + exact match) → `PATCH`/`POST` |

The second pattern is handled by the shared `findByName` helper in
`lib/authentikApi.ts` (authentik's `name` list filter narrows server-side;
`findByName` still verifies an exact match client-side, since authentik does
not enforce name-uniqueness on every resource). The third pattern is
`findByName`'s generalization, `findByField` — for a resource whose upsert
identity is a different field the list endpoint can filter on.

Four config types — **Policies**, **Stages**, **Sources**, and none of the
others — cover more than one authentik model behind a single canvas `type`
selector, because authentik itself splits them into genuinely distinct REST
resources (e.g. `ExpressionPolicy` vs. `PasswordPolicy`) rather than one
resource with a discriminator column. Each selected type reads/writes its
OWN endpoint; retyping an existing item after a prior deploy creates a NEW
object under the new type's endpoint rather than migrating it (documented in
each type's `canvas.yaml`).

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

## SAML Providers config type

Each item is one authentik SAML Provider, upserted by **name** (like
OAuth2/OpenID Providers — a server-assigned integer `pk`) over
`/api/v3/providers/saml/`: `name`, `authorization_flow` / `invalidation_flow`
(UUIDs, both required), `acs_url` (required), `audience`, `sp_binding`
(`redirect` default | `post`), `sign_assertion` / `sign_response`, and
`property_mappings` (opt-in-managed, same convention as OAuth2/OpenID
Providers). **Dropped for now** (real, writable fields authentik defaults
when omitted): signing/verification/encryption keypair references, SLS
(logout) URL/binding, NameID/AuthnContextClassRef mapping overrides, digest/
signature algorithm, assertion/session validity windows, default relay state
and default NameID policy.

## Proxy Providers config type

Each item is one authentik Proxy Provider, upserted by **name** over
`/api/v3/providers/proxy/`: `name`, flows (required), `mode` (`proxy` default
| `forward_single` | `forward_domain`), `internal_host` (required only in
`proxy` mode), `external_host` (required), upstream SSL validation, skip-auth
path regexes, HTTP-Basic header injection, cookie domain, `property_mappings`.
**Dropped for now:** `certificate` (a keypair reference), per-attribute
Basic-Auth key overrides, JWT federation sources/providers, access/refresh
token validity overrides, `intercept_header_auth`.

## LDAP Providers config type

Each item is one authentik LDAP Provider, upserted by **name** over
`/api/v3/providers/ldap/`: `name`, flows (required), `base_dn` (required),
`uid_start_number` / `gid_start_number` (opt-in-managed), `search_mode` /
`bind_mode` (`direct` default | `cached`), `mfa_support`, `property_mappings`.
**Dropped for now:** `certificate` (a keypair reference), `tls_server_name`.

## Scope Property Mappings config type

Each item is one authentik OAuth2/OpenID scope mapping, upserted by **name**
over `/api/v3/propertymappings/provider/scope/`: `name`, `scope_name`
(required), `description` (shown at consent), `expression` (required — the
Python expression that computes the scope's claims). This **unblocks a real
dependency**: deploy a mapping here, then paste its pk into an OAuth2/OpenID
Provider's Scope/Property Mappings field. Only the OAuth2/OpenID ("scope")
mapping subtype is covered — see Coverage for the other property-mapping
subtypes.

## Policies config type

Covers three genuinely distinct authentik models behind one canvas `type`
selector — each with its own endpoint, upserted by **name within that
endpoint**:

| Type | Endpoint | Fields |
| --- | --- | --- |
| Expression | `/policies/expression/` | `name`, `execution_logging`, `expression` (required) |
| Password | `/policies/password/` | `name`, `execution_logging`, `password_field`, length/character-class minimums, `check_have_i_been_pwned`, `check_zxcvbn` |
| Reputation | `/policies/reputation/` | `name`, `execution_logging`, `check_ip`, `check_username`, `threshold` |

`name` is the only field required by every type's schema beyond its type
-specific fields. **Dropped for now:** Password policy's `symbol_charset` /
`error_message` / `check_static_rules` / `hibp_allowed_count` /
`zxcvbn_score_threshold` (excess detail). Reputation **scores** themselves
(as opposed to the policy) are computed by authentik from live login/failure
events and are never authored. Binding a policy to a flow/application/group
(`PolicyBinding`) is not covered — see Coverage.

## Stages config type

Covers four genuinely distinct authentik models behind one canvas `type`
selector — each with its own endpoint (note the nested `authenticator/validate`
path), upserted by **name within that endpoint**:

| Type | Endpoint | Fields |
| --- | --- | --- |
| Identification | `/stages/identification/` | `user_fields`, case-insensitive matching, show-matched-user, pretend-user-exists, enrollment/recovery flow UUIDs |
| Password | `/stages/password/` | `backends` (required), `failed_attempts_before_cancel`, `allow_show_password` |
| Authenticator Validation | `/stages/authenticator/validate/` | `device_classes`, `not_configured_action`, `last_auth_threshold` |
| User Login | `/stages/user_login/` | `session_duration`, `terminate_other_sessions`, `remember_me_offset` |

A stage created here is immediately usable in authentik's own flow editor.
**Per-flow stage bindings — which flow runs a stage, in what order, under
what policy (`FlowStageBinding`) — are NOT authored here**; see Coverage.

## Sources config type

Covers two genuinely distinct authentik models behind one canvas `type`
selector — each with its own endpoint — but, like Applications/Flows, a
source's `slug` IS its API path key, so this retrieves by identity directly
(within the selected type's endpoint) rather than listing and matching by
name:

| Type | Endpoint | Fields |
| --- | --- | --- |
| OAuth | `/sources/oauth/` | `provider_type` (16 known values), `consumer_key` (required), `consumer_secret` (required on create), authorization/token/profile/well-known URLs |
| LDAP | `/sources/ldap/` | `server_uri` (required), `bind_cn`, `bind_password`, `base_dn` (required), `start_tls` |

**Secrets are write-only.** `consumer_secret` and `bind_password` are
`writeOnly: true` in authentik's own schema — a `GET` never returns them, so
this config type cannot read them back to diff or restore on rollback. They
are sent only when the canvas item declares a non-blank value (set/rotate);
blank leaves the live secret untouched, and rollback never touches one either
way.

## Brands config type

Each item is one authentik Brand — the per-domain tenant branding + default
-flow record — upserted by **domain** (a server-assigned UUID path key, via
the generic `findByField` helper) over `/api/v3/core/brands/`: `domain`
(required), `default`, `branding_title` / `branding_logo` /
`branding_favicon`, `flow_authentication` / `flow_invalidation` /
`flow_recovery` (UUIDs), `attributes`. **Dropped for now:**
`branding_custom_css`, `branding_map_tiles`, the secondary flow overrides
(`flow_user_switch`, `flow_unenrollment`, `flow_user_settings`,
`flow_device_code`, `flow_lockdown`, `flow_request`), `default_application`,
`web_certificate` (a keypair reference) and `client_certificates`.

## Coverage

authentik's REST API (`/api/v3/schema/`) is large. This app manages the
declarative, standalone-object surface — every config type below was verified
against the live OpenAPI schema before being built (see References). What
follows is the full accounting: **managed**, and **excluded** with the reason,
not silently dropped.

### Managed (12 config types)

| Config type | Endpoint(s) |
| --- | --- |
| `applications` | `/core/applications/` |
| `oauth2-providers` | `/providers/oauth2/` |
| `saml-providers` | `/providers/saml/` |
| `proxy-providers` | `/providers/proxy/` |
| `ldap-providers` | `/providers/ldap/` |
| `groups` | `/core/groups/` |
| `flows` | `/flows/instances/` |
| `stages` | `/stages/identification/`, `/stages/password/`, `/stages/authenticator/validate/`, `/stages/user_login/` |
| `scope-property-mappings` | `/propertymappings/provider/scope/` |
| `policies` | `/policies/expression/`, `/policies/password/`, `/policies/reputation/` |
| `sources` | `/sources/oauth/`, `/sources/ldap/` |
| `brands` | `/core/brands/` |

### Excluded by design (not a gap — a boundary)

- **Users** (`/core/users/`, recovery/password/impersonation sub-resources).
  Users are provisioned dynamically — through a Source's sync (LDAP/OAuth) or
  a future SCIM provider — not hand-authored as a flat declarative list the
  way an Application or Provider is. User records also carry PII and
  sensitive lifecycle actions (impersonation, forced password/recovery) that
  don't fit a validate/deploy/drift/rollback config pipeline.
- **API Tokens / App Passwords** (`/core/tokens/`). These ARE authentik's own
  credentials — the same category this app's own connection token belongs
  to. Authoring them as "config" would mean diffing and rolling back secret
  material; the platform's credential vault is the correct home for that, not
  a config-as-code surface.
- **Certificates / Keypairs** (`/crypto/certificatekeypairs/`). Private key
  material. Every config type that references one (`signing_kp`,
  `verification_kp`, `encryption_kp`, `certificate`, `web_certificate`,
  `client_certificates`) does so by an EXISTING keypair's UUID — this app
  never generates or imports key material.
- **Per-flow Stage Bindings** (`FlowStageBinding`, under `/flows/bindings/`)
  **and Policy Bindings** (`PolicyBinding`, under `/policies/bindings/`).
  Wiring a Stage into a Flow (or a Policy onto a Flow/Application/Group) is an
  ORDERED GRAPH — position, re-evaluate-on-change, PASS/FAIL policy
  semantics — not a flat list of independent items the way every other config
  type here is. Stages and Policies themselves ARE fully managed as
  standalone, reusable objects (immediately usable in authentik's own flow
  editor); only the graph edges connecting them are out of scope for this
  wave.
- **Outposts** (`/outposts/outposts/`, service connections). An Outpost is a
  RUNNING WORKLOAD (a proxy/LDAP/RAC/RADIUS container) that ties to
  infrastructure lifecycle, not a REST object you diff — it belongs alongside
  the BYOL infrastructure model (v0.3.0), as a future infra-side concern, not
  a v0.4.0 config type.
- **Reputation scores** (as opposed to the Reputation *policy*, which IS
  managed). Scores are computed by authentik from live login/failure events —
  there's nothing to author.
- **Read-only / runtime / telemetry surfaces**: events and the audit log,
  system tasks, health/monitoring, admin system actions, enterprise licenses,
  RBAC role/permission assignment, authenticator devices. None of these are
  declarative configuration.

### Not yet built — legitimate follow-up, not infeasible

These are real, feasible, schema-verified surfaces that follow the SAME
patterns already established here; they were left out of this wave for scope
discipline, not because they're impossible:

- **RAC, RADIUS and SCIM Providers** (`/providers/rac/`, `/providers/radius/`,
  `/providers/scim/`) — additional Provider subtypes alongside OAuth2/OpenID,
  SAML, Proxy and LDAP; same server-assigned-`pk`/upsert-by-name pattern.
- **Other property-mapping subtypes** (`/propertymappings/saml/`,
  `/propertymappings/ldap/`, `/propertymappings/notification/`,
  `/propertymappings/rac/`, `/propertymappings/scim/`, source-specific
  mappings, …) — only the OAuth2/OpenID "scope" subtype is built; the others
  are structurally identical (same UUID-identity pattern) with different
  fields.

No undocumented endpoint or guessed request shape is represented as managed.

## Pagination

List reads — every config type that upserts by `name` (OAuth2/OpenID, SAML,
Proxy, LDAP Providers; Groups; Scope Property Mappings; Policies; Stages) or
by another field (Brands, by `domain`), via `findByName` / `findByField` —
page through authentik's custom envelope:

```json
{ "pagination": { "next": 2, "previous": null, "count": 42, "current": 1, "total_pages": 3, "start_index": 1, "end_index": 20 },
  "results": [ ... ],
  "autocomplete": { ... } }
```

`pagination.next` / `.previous` are **page numbers** (or a falsy value at the
start/end of the set), not URLs — different from plain DRF's default
`PageNumberPagination`. `lib/authentikApi.ts`'s `listAll` pages via the numeric
`page` query param accordingly; `findByName` / `findByField` layer an
exact-match filter on top of it.

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
  - `SAMLProvider` / `SAMLProviderRequest` / `PatchedSAMLProviderRequest` /
    `SAMLBindingsEnum`
  - `ProxyProvider` / `ProxyProviderRequest` / `PatchedProxyProviderRequest` /
    `ProxyMode`
  - `LDAPProvider` / `LDAPProviderRequest` / `PatchedLDAPProviderRequest` /
    `LDAPAPIAccessMode`
  - `Group` / `GroupRequest` / `PatchedGroupRequest`
  - `Flow` / `FlowRequest` / `PatchedFlowRequest` / `FlowDesignationEnum` /
    `AuthenticationEnum`
  - `IdentificationStageRequest` / `PasswordStageRequest` /
    `AuthenticatorValidateStageRequest` / `UserLoginStageRequest` /
    `UserFieldsEnum` / `BackendsEnum` / `DeviceClassesEnum` /
    `NotConfiguredActionEnum`
  - `ScopeMapping` / `ScopeMappingRequest` / `PatchedScopeMappingRequest`
  - `ExpressionPolicyRequest` / `PasswordPolicyRequest` /
    `ReputationPolicyRequest`
  - `OAuthSourceRequest` / `LDAPSourceRequest` / `ProviderTypeEnum`
  - `Brand` / `BrandRequest` / `PatchedBrandRequest`
- Applications — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/core-applications-list,
  core-applications-create, core-applications-retrieve,
  core-applications-partial-update, core-applications-destroy
- OAuth2/OpenID Providers — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/providers-oauth2-list,
  providers-oauth2-create, providers-oauth2-retrieve,
  providers-oauth2-partial-update, providers-oauth2-destroy
- SAML Providers — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/providers-saml-list,
  providers-saml-create, providers-saml-retrieve,
  providers-saml-partial-update, providers-saml-destroy
- Proxy Providers — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/providers-proxy-list,
  providers-proxy-create, providers-proxy-retrieve,
  providers-proxy-partial-update, providers-proxy-destroy
- LDAP Providers — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/providers-ldap-list,
  providers-ldap-create, providers-ldap-retrieve,
  providers-ldap-partial-update, providers-ldap-destroy
- Groups — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/core-groups-list, core-groups-create,
  core-groups-retrieve, core-groups-partial-update, core-groups-destroy
- Flows — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/flows-instances-list,
  flows-instances-create, flows-instances-retrieve,
  flows-instances-partial-update, flows-instances-destroy
- Stages — list/create/retrieve/update/delete (per type):
  https://api.goauthentik.io/reference/stages-identification-list,
  stages-password-list, stages-authenticator-validate-list,
  stages-user-login-list (and the matching `-create`/`-retrieve`/
  `-partial-update`/`-destroy` operations)
- Scope Property Mappings — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/propertymappings-provider-scope-list,
  propertymappings-provider-scope-create,
  propertymappings-provider-scope-retrieve,
  propertymappings-provider-scope-partial-update,
  propertymappings-provider-scope-destroy
- Policies — list/create/retrieve/update/delete (per type):
  https://api.goauthentik.io/reference/policies-expression-list,
  policies-password-list, policies-reputation-list (and the matching
  `-create`/`-retrieve`/`-partial-update`/`-destroy` operations)
- Sources — list/create/retrieve/update/delete (per type):
  https://api.goauthentik.io/reference/sources-oauth-list,
  sources-ldap-list (and the matching `-create`/`-retrieve`/
  `-partial-update`/`-destroy` operations)
- Brands — list/create/retrieve/update/delete:
  https://api.goauthentik.io/reference/core-brands-list, core-brands-create,
  core-brands-retrieve, core-brands-partial-update, core-brands-destroy

## BYOL infrastructure hosting

Beyond configuring an existing authentik instance, this app can provision and
manage a dedicated authentik stack end to end (bring-your-own-license): define
a topology, deploy to a Veltrix-hosted or your own cloud account, then manage
its lifecycle from the **Infrastructure** page (Settings nav group). This
follows the same node_tiers-native BYOL model as `apps/greenbone` and
`apps/keycloak` — an app-owned `/byol` route surface + DB tables, wrapping the
SDK's `<ByolInfrastructureManager>` for the console UI.

### Topology

authentik ships **one container image** that runs as either role via its
startup command:

| Tier | Kind | Role | Ports |
| --- | --- | --- | --- |
| **Server** (scalable, min 1) | `authentik-server` | Web/API — the ALB target; runs `command: server` | 9000 HTTP (ALB target), 9443 HTTPS (direct/admin) |
| **Worker** (scalable, min 1) | `authentik-worker` | Background tasks (scheduled jobs, outpost sync, flow stages); runs `command: worker` | none exposed |
| PostgreSQL (fixed, single) | `postgres` | authentik's database | 5432 (peer-only) |

A single-node deployment collapses everything to one all-in-one `standalone`
box. Multi-site placement (per availability zone or per region) is available
on the Server and Worker tiers in a distributed deployment.

### ⚠ No Redis — verified, not an oversight

Earlier authentik releases needed Redis for caching, the task broker, the
embedded outpost's session store and WebSocket connections. **authentik 2025.10
removed this dependency entirely:**

> "In previous versions, authentik used Redis for caching, tasks, the embedded
> proxy outpost's session store, and WebSocket connections. Since 2025.8, tasks
> were migrated to use Postgres. With this release we've also migrated
> caching, the embedded outpost, and WebSocket to Postgres, fully removing the
> need for Redis."
> — [authentik 2025.10 release notes](https://docs.goauthentik.io/releases/2025.10/), "Breaking changes"

Corroborated directly against the CURRENT official
[`docker-compose.yml`](https://docs.goauthentik.io/compose.yml) (tag
`2026.5.6` at research time) and the official
[Helm chart's `values.yaml`](https://raw.githubusercontent.com/goauthentik/helm/main/charts/authentik/values.yaml)
— neither references Redis anywhere; both wire `server` and `worker` to
PostgreSQL only. This topology was built to match, not a template shape that
predates the removal.

### Ports & health checks (cited)

- **9000 (HTTP)** / **9443 (HTTPS)** — authentik's internal listener ports.
  ("By default, authentik listens internally on port 9000 for HTTP and 9443
  for HTTPS." —
  [docs.goauthentik.io/docs/install-config/install/docker-compose](https://docs.goauthentik.io/docs/install-config/install/docker-compose))
- **`GET /-/health/live/`** and **`GET /-/health/ready/`** on port 9000 — the
  server's liveness/readiness endpoints (verified against the official Helm
  chart's `values.yaml`, `server.livenessProbe`/`readinessProbe`, `httpGet`
  port `"http"` = 9000). The load balancer's health check uses
  `/-/health/live/`.
- The **worker** exposes no HTTP port at all in the reference deployments —
  its own k8s liveness/readiness probes run `exec: [ak, healthcheck]`, not an
  HTTP call.
- Same image, different command — confirmed directly in the official
  `docker-compose.yml`: both the `server` and `worker` services use
  `image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}` and differ only in
  `command: server` / `command: worker`; both `depends_on` PostgreSQL.

**Flagged as reasonable defaults to verify**, not confirmed by authentik's own
docs: exact per-tier instance sizing, and terminating public TLS at the load
balancer and forwarding HTTP to port 9000 internally (vs. forwarding straight
to the server's native HTTPS on 9443). Verify against your scale and TLS
posture before treating this as production-grade.

### Provisioning + usage foundation

- `authentik_byol_infrastructure` — the stack record (topology, deployment
  target, `node_tiers` JSONB).
- `authentik_byol_resource` — one row per planned resource (network, LB,
  server/worker nodes, PostgreSQL, …), keyed by a stable `plan_key`.
- `authentik_byol_deployment` / `authentik_byol_deployment_step` — deploy/destroy
  runs and their ordered Activity-timeline steps.
- `authentik_byol_state_event` / `authentik_byol_usage` — an append-only
  lifecycle log and the daily node-hours usage ledger it derives (foundation
  for usage-based billing).

None of this touches the existing REST API configuration seam
(`lib/authentikApi.ts`) — BYOL infrastructure and configuration-as-code are
independent concerns that happen to target the same instance once deployed.

## Development

```
cd apps/authentik
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs authentik      # run handler tests
node ../../scripts/validate-app.mjs apps/authentik   # validate against the app contract
```
