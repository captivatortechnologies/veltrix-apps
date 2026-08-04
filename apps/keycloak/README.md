# Keycloak

Manage [Keycloak](https://www.keycloak.org/) (open-source Identity and Access
Management) **as code**. Author Keycloak configuration in the Veltrix
Configuration Canvas and drive it through the Security-as-Code pipeline —
validate, deploy, health check, drift detection and rollback — over the
**Keycloak Admin REST API**, with optional **BYOL infrastructure hosting** for
the Keycloak stack itself.

- **Category:** IAM
- **App id:** `keycloak`
- **Version:** 0.4.0
- **Config types (16):** `clients`, `client-scopes`, `protocol-mappers`,
  `realm-roles`, `client-roles`, `default-roles`, `groups`,
  `authentication-flows`, `required-actions`, `realm-settings`,
  `client-profiles`, `client-policies`, `user-federation`,
  `identity-providers`, `identity-provider-mappers`, `authorization`
- See **Coverage** below for exactly what's managed vs. excluded, and why.

## What it manages

| Config type | Keycloak object | API |
| --- | --- | --- |
| **Clients** | OIDC / SAML clients (`clientId`, name, protocol, enabled, public/confidential, standard flow, redirect URIs) | `/admin/realms/{realm}/clients` |
| **Client Scopes** | Client scopes (name, protocol, consent text, token/discovery inclusion, GUI order) + realm default/optional assignment | `/admin/realms/{realm}/client-scopes`, `/default-{default,optional}-client-scopes` |
| **Protocol Mappers** | OIDC/SAML claim/attribute mappers attached to an existing client OR client scope | `/clients/{id}/protocol-mappers/models`, `/client-scopes/{id}/protocol-mappers/models` |
| **Realm Roles** | Realm-level roles (name, description, composite flag) | `/admin/realms/{realm}/roles` |
| **Client Roles** | Roles scoped to a specific client | `/admin/realms/{realm}/clients/{id}/roles` |
| **Default Roles** | The realm's default composite role's children (realm + client roles every new user gets) | `/admin/realms/{realm}/roles-by-id/{id}/composites` |
| **Groups** | Top-level realm groups (attributes, assigned realm roles) | `/admin/realms/{realm}/groups` |
| **Authentication Flows** | Custom authentication flow containers (alias, description, provider type) | `/admin/realms/{realm}/authentication/flows` |
| **Required Actions** | Enable/default/reorder the realm's required actions (`UPDATE_PASSWORD`, `CONFIGURE_TOTP`, …) | `/admin/realms/{realm}/authentication/required-actions` |
| **Realm Settings** | Realm-wide token lifespans, login flags, password policy (a singleton) | `PUT /admin/realms/{realm}` |
| **Client Profiles** | Named, ordered executor sets for the FAPI-style client-policies framework | `/admin/realms/{realm}/client-policies/profiles` |
| **Client Policies** | Named condition sets that apply one or more Client Profiles to matching clients | `/admin/realms/{realm}/client-policies/policies` |
| **User Federation** | LDAP and standalone Kerberos user-storage providers | `/admin/realms/{realm}/components` (providerType `org.keycloak.storage.UserStorageProvider`) |
| **Identity Providers** | OIDC/SAML/social identity provider instances | `/admin/realms/{realm}/identity-provider/instances` |
| **Identity Provider Mappers** | Attribute/role/group mappers on an existing identity provider instance | `/identity-provider/instances/{alias}/mappers` |
| **Authorization** | A client's fine-grained authorization services — resources, scopes, permissions, role-based policies | `/clients/{id}/authz/resource-server/**` |

Every config type follows the same lifecycle: **validate** (static field/format
checks), **deploy** (upsert by the type's stable identity), **rollback**
(restore the prior representation or delete what this app created), **drift
detect** (compare declared fields against live, best-effort), **health check**
(admin token accepted + realm reachable), **status** (from platform deployment
records).

## Authentication

The app talks to the **Admin REST API** at `<host>/admin/realms/{realm}/…` using
an **admin access token** obtained from the OpenID Connect token endpoint:

```
POST <host>/realms/{auth_realm}/protocol/openid-connect/token
```

Two grants are supported:

1. **Client credentials (primary).** An admin **service-account client**. Store
   its **client-id** in the credential `username` and its **client secret** in
   `apiToken`. On that client, enable *Service accounts roles* and assign the
   realm-management roles **`manage-clients`**, **`manage-realm`**,
   **`manage-users`**, **`manage-identity-providers`**, **`manage-authorization`**
   and **`view-realm`** for the managed realm — the exact set needed depends on
   which of the 16 config types above you deploy (see each type's endpoints).
2. **Password grant (alternative).** An **admin username + password**, exchanged
   against the built-in public `admin-cli` client. Store the username in
   `username` and the password in `password`.

The issued token is sent as `Authorization: Bearer <token>`.

### Connection & settings

A **Connection** carries the Keycloak **base URL** (endpoint) + the admin
credential (client-id + secret). Realm selection lives in **app settings**:

| Setting | Default | Meaning |
| --- | --- | --- |
| `realm` | `master` | The realm this app manages (`{realm}` in the admin paths). |
| `auth_realm` | `master` | The realm that issues the admin token (where the service-account client / admin user lives). Set it to the managed realm if the service-account client is registered there. |
| `verify_tls` | `false` | Enforce a valid TLS certificate. Off by default — self-hosted Keycloak commonly ships a self-signed certificate. |

The **connectivity test** obtains a token and reads the managed realm
(`GET /admin/realms/{realm}`): a 2xx confirms the endpoint resolves, the token was
issued, and it authorizes admin access.

## Config type notes

Full endpoint tables and representation field lists live in each config type's
`_shared.ts` header comment (cited against official sources) — this section
covers the identity model and any notable behavior per type.

### Access — Clients, Client Scopes, Protocol Mappers, Realm/Client/Default Roles, Groups

- **Clients** upsert by `clientId` (list + match, since the path id is an
  internal UUID). Rollback restores the prior representation or deletes a
  created client.
- **Client Scopes** upsert by `name` (list + client-side match — the endpoint
  has no server-side name filter). `consentScreenText` /
  `displayOnConsentScreen` / `includeInTokenScope` /
  `includeInOpenidProviderMetadata` / `guiOrder` are not top-level fields —
  Keycloak stores them inside `attributes` under
  `consent.screen.text` / `display.on.consent.screen` /
  `include.in.token.scope` / `include.in.openid.provider.metadata` /
  `gui.order` (verified against `ClientScopeModel.java`). A `realmDefault`
  field (`none`/`default`/`optional`) is reconciled separately via
  `PUT`/`DELETE /default-default-client-scopes/{id}` and
  `/default-optional-client-scopes/{id}` after the scope body is written.
- **Protocol Mappers** attach to either an existing client (`targetType:
  client`) or client scope (`targetType: client-scope`) by human identifier,
  resolved to the parent's internal UUID at deploy time. Identity is the
  composite `(targetType, targetRef, name)`.
- **Realm Roles** upsert by `name` (the `{role-name}` path segment directly —
  no list/match needed).
- **Client Roles** mirror Realm Roles but scoped under a client resolved from
  its human `clientId`; identity is the composite `(clientId, name)` since role
  names are only unique within a client.
- **Default Roles** is a realm-wide **singleton** (one item, no per-item
  identity) that reconciles the realm's special composite default role
  (`RealmRepresentation.defaultRole`) to a declared set of realm roles (a tag
  list) and client roles (a JSON object `{clientId: [roleNames]}`), via
  `/roles-by-id/{id}/composites`. **An empty declared set removes every
  current default, including Keycloak's own `offline_access`/
  `uma_authorization`** — validate.ts warns if both fields are empty.
- **Groups** manages **top-level** groups only (sub-groups deferred); realm
  role assignment is reconciled via the dedicated
  `/groups/{id}/role-mappings/realm` endpoint, unchanged from prior releases.

### Authentication — Authentication Flows, Required Actions

- **Authentication Flows** manages the flow **container** only (`alias`,
  `description`, `providerId`) — creating custom top-level flows and renaming/
  deleting ones this app owns. It **never touches a `builtIn: true` flow**
  (Keycloak's own `browser`, `direct grant`, etc. — deploy fails that item
  loudly rather than silently skipping or, worse, rewriting one). It also does
  **not** author the execution/step graph inside a flow (which authenticators
  run, in what order, under what requirement — a materially riskier, ordered
  API surface) — a flow created here is an empty container immediately usable
  in Keycloak's own flow designer, the same boundary the sibling `authentik`
  app draws around its own Flows config type (`FlowStageBinding` excluded
  there too).
- **Required Actions** upserts by `alias` directly (`GET
  /required-actions/{alias}`). An alias not yet registered in this realm is
  registered first via `POST /authentication/register-required-action`, then
  configured; rollback fully de-registers what this app registered, or
  restores the prior configuration otherwise.

### Realm — Realm Settings, Client Profiles, Client Policies

- **Realm Settings** is a realm-wide **singleton** over `PUT
  /admin/realms/{realm}` covering Tokens (lifespans, all plain integer
  seconds on the wire — verified against `RealmRepresentation.java`), Login
  flags (`registrationAllowed`, `verifyEmail`, … — `duplicateEmailsAllowed`
  and `loginWithEmailAllowed` are mutually exclusive, enforced at validate
  time) and the raw `passwordPolicy` DSL string. **`rollbackData` never
  persists the full realm representation** (which embeds
  `smtpServer.password`) — only the narrow set of fields this config type
  authors, to keep unrelated secrets out of the platform's rollback-data
  store.
- **Client Profiles** and **Client Policies** are realm-wide **whole-list**
  config types (`GET`/`PUT /client-policies/profiles` and `.../policies`) —
  every canvas item collectively forms ONE list; deploy issues one GET + one
  PUT covering every item together, the same shape `cisco-meraki`'s ordered
  firewall-rule lists use, generalized from "per network" to "per realm".
  **Global built-ins are never touched**: `ClientProfilesRepresentation`/
  `ClientPoliciesRepresentation` carry `profiles`/`policies` (ours) separately
  from `globalProfiles`/`globalPolicies` (Keycloak's own FAPI baseline/
  advanced sets) — verified directly against Keycloak server source
  (`ClientProfilesRepresentation.java`, `ClientPoliciesRepresentation.java`,
  `ClientPoliciesUtil.java`): omitting the global field from a PUT is not just
  safe, it's the *only* sanctioned way to write these endpoints (the server
  actively nulls any attempt to include one). A client policy's `mode` field
  (`ClientPolicyMode`, e.g. `STRICT`) is not authored by this config type — a
  non-default `mode` set via the Admin Console is reset on the next deploy,
  since Keycloak's PUT is a genuine full replace.

### Federation — User Federation, Identity Providers, Identity Provider Mappers

- **User Federation** covers LDAP and standalone Kerberos user-storage
  providers as Keycloak **Component** objects (`config` is a
  `MultivaluedHashMap<String,String>` — every value is a string array even for
  single-valued settings, verified against `ComponentRepresentation.java`).
  **`bindCredential` and `keyTab` are write-only**: Keycloak masks them on GET
  as the literal `"**********"`, so they are sent only when the canvas item
  declares a non-blank value, never diffed, and **stripped from every
  captured "prior" state before it can be replayed** — both an update-merge
  and a rollback would otherwise risk writing that masked placeholder over a
  real live secret. LDAP attribute keys (`usernameLDAPAttribute`,
  `rdnLDAPAttribute`, `uuidLDAPAttribute`), the `vendor` enum
  (`other`/`edirectory`/`ad`/`rhds`/`tivoli`, lower-case) and `searchScope`
  (the numeric string `"1"`/`"2"`, not a word) are all verified directly
  against Keycloak's `LDAPConstants.java`/`LDAPConfig.java` source.
- **Identity Providers** (unchanged from prior releases) upserts by `alias`
  directly; `config` keys containing "secret" are write-only and excluded from
  drift.
- **Identity Provider Mappers** attach to an **existing** identity provider
  instance by alias (this config type does not create IdPs); identity is the
  composite `(alias, name)`.

### Authorization — a client's resource server

One config type, a `kind` selector (`resource` / `scope` / `permission` /
`role-policy`) covering four distinct Admin REST sub-resources under
`/clients/{id}/authz/resource-server`. **Precondition, checked before every
deploy**: the target client must already have authorization services enabled
(`GET .../resource-server` must be 2xx) — deploy fails fast with an actionable
message otherwise, the same posture `cisco-meraki`'s appliance-vlans config
type takes for its own "VLANs must be enabled first" precondition. A
role-policy's `roles` field accepts either a bare realm-role name (`"admin"`)
or `"clientId/roleName"` for a client role — the same flat-string convention
the official `keycloak_default_roles` Terraform resource uses for its own
`default_roles` list. **Only `role` policies are built** — see Coverage below
for the policy types intentionally left for a follow-up.

## Coverage

Coverage was researched against the official [Keycloak Admin REST API
reference](https://www.keycloak.org/docs-api/latest/rest-api/index.html), the
[`keycloak/terraform-provider-keycloak`](https://github.com/keycloak/terraform-provider-keycloak)
resource docs, and — for every field/endpoint cited as "verified" above and
below — Keycloak's own server source
([`keycloak/keycloak`](https://github.com/keycloak/keycloak) on GitHub:
`RealmRepresentation.java`, `ClientScopeModel.java`,
`RequiredActionProviderRepresentation.java`, `ComponentRepresentation.java`,
`LDAPConstants.java`, `LDAPConfig.java`, `ClientProfilesRepresentation.java`,
`ClientPoliciesRepresentation.java`, `ClientPoliciesUtil.java`,
`IdentityProviderMapperRepresentation.java`, `AuthenticationManagementResource.java`,
`ResourceServerService.java`, `ResourceSetService.java`, `PolicyService.java`,
`PermissionService.java`). What follows is the full accounting: **managed**,
and **excluded** with the reason — not silently dropped.

### Managed (16 config types)

| Config type | Endpoint(s) |
| --- | --- |
| `clients` | `/admin/realms/{realm}/clients` |
| `client-scopes` | `/admin/realms/{realm}/client-scopes`, `/default-{default,optional}-client-scopes` |
| `protocol-mappers` | `/clients/{id}/protocol-mappers/models`, `/client-scopes/{id}/protocol-mappers/models` |
| `realm-roles` | `/admin/realms/{realm}/roles` |
| `client-roles` | `/admin/realms/{realm}/clients/{id}/roles` |
| `default-roles` | `/admin/realms/{realm}/roles-by-id/{id}/composites` (target resolved from `RealmRepresentation.defaultRole`) |
| `groups` | `/admin/realms/{realm}/groups`, `/groups/{id}/role-mappings/realm` |
| `authentication-flows` | `/admin/realms/{realm}/authentication/flows` |
| `required-actions` | `/admin/realms/{realm}/authentication/required-actions`, `/register-required-action` |
| `realm-settings` | `PUT /admin/realms/{realm}` |
| `client-profiles` | `/admin/realms/{realm}/client-policies/profiles` |
| `client-policies` | `/admin/realms/{realm}/client-policies/policies` |
| `user-federation` | `/admin/realms/{realm}/components` (providerType `org.keycloak.storage.UserStorageProvider`) |
| `identity-providers` | `/admin/realms/{realm}/identity-provider/instances` |
| `identity-provider-mappers` | `/identity-provider/instances/{alias}/mappers` |
| `authorization` | `/clients/{id}/authz/resource-server/{resource,scope,permission,policy}` |

Every whole-list endpoint (Client Profiles, Client Policies) captures the
complete prior list for rollback. Every UUID-addressed endpoint resolves its
human identity (name/clientId/alias) via list-and-match or direct retrieve,
never assumes a server-side filter is exact, and stores the resolved internal
id in `rollbackData` so rollback is immune to a rename between deploy and
rollback.

### Intentionally excluded (not a gap — a boundary)

- **Users** (`/admin/realms/{realm}/users`, credentials, sessions,
  impersonation). Users are provisioned dynamically — through User Federation
  sync (LDAP/Kerberos) or direct signup — not hand-authored as a flat
  declarative list. User records carry PII and security-sensitive lifecycle
  actions (forced password reset, impersonation) that don't fit a
  validate/deploy/drift/rollback pipeline — the same boundary the sibling
  `authentik` app draws around its own Users resource.
- **Realm keys / signing & encryption certificates**
  (`/admin/realms/{realm}/keys`, client attribute certificates
  `/clients/{id}/certificates/{attr}`). Private key material — this app never
  generates or imports it. A realm-level key **provider** (an
  `org.keycloak.keys.KeyProvider` Component, e.g. `rsa-generated`,
  `hmac-generated`) is architecturally identical to User Federation's
  Component pattern and is a legitimate future config type (see below), but
  key MATERIAL itself is always excluded.
- **Client secrets / admin credentials** (`/clients/{id}/client-secret`,
  service-account tokens, this app's own admin credential). These ARE
  credentials, the same category the app's own connection secret belongs to —
  the platform's credential vault is the correct home, not a config-as-code
  surface.
- **Client Initial Access Tokens / Client Registration Policy**
  (`/clients-initial-access`, `/client-registration-policy/providers`).
  Dynamic-client-registration bootstrap tokens are themselves credential
  material for a self-registration flow, not declarative configuration.
- **Users' role/group assignments, sessions, attack-detection unlocks**
  (`/users/{id}/role-mappings`, `/attack-detection/brute-force/**`). Per-user
  imperative actions — there is no "user" object to attach a canvas item to
  (see Users above).
- **Read-only / runtime / telemetry surfaces**: events and the admin event
  log, realm keys (read endpoint), client-registration-policy providers list,
  and any endpoint that only supports `GET`. None of these are declarative
  configuration.

### Not yet built — legitimate follow-up, not infeasible

These are real, schema-verified surfaces that would follow the same patterns
already established here; left out of this wave for scope discipline:

- **Realm key providers** (`org.keycloak.keys.KeyProvider` Components —
  `rsa-generated`, `hmac-generated`, `ecdsa-generated`, `aes-generated`,
  `java-keystore`, `rsa` — the `keycloak_realm_keystore_*` Terraform
  resources) — architecturally identical to `user-federation`'s Component
  pattern with a different `providerType`.
- **Realm User Profile** (`/admin/realms/{realm}/users/profile` — the
  declarative schema of which user attributes exist and how they validate;
  `keycloak_realm_user_profile`).
- **Realm Localization** (`/admin/realms/{realm}/localization/{locale}` —
  per-locale message overrides; `keycloak_realm_localization`).
- **Realm Events config** (`/admin/realms/{realm}/events/config` — admin/user
  event listener enablement and log retention; `keycloak_realm_events`).
- **Organizations** (`/admin/realms/{realm}/organizations` — a newer Keycloak
  feature: orgs, domains, invitations, membership).
- **Additional authorization policy types**: `js`, `time`, `user`, `client`,
  `group`, `aggregate`, `regex` (only `role` policies are built in the
  `authorization` config type — the same "documented subset, not silently
  dropped" framing the sibling `authentik` app uses for its own out-of-scope
  provider subtypes).
- **Fine-grained admin permissions v2** (`group_admin_permissions`,
  `role_admin_permissions`, `users_admin_permissions` in the Terraform
  provider) — a newer Keycloak authorization-services-for-the-admin-console
  feature, structurally similar to `authorization` but targeting admin
  resources instead of application resources.
- **Client Registration Policy instances** (as opposed to the bootstrap
  tokens above) — policies that govern dynamic client self-registration.

No undocumented endpoint or guessed request shape is represented as managed.

### Verify against a live Keycloak

Every endpoint above was researched against official docs, the Terraform
provider, and (where cited) Keycloak's own server source — but the following
were not independently traced with the same rigor as the rest, and should be
confirmed live before depending on them in production:

- **`authorization`**: `PUT`/`DELETE /authz/resource-server/{permission,policy}/{id}`
  without a type segment once the id is known (the CREATE sub-paths ARE
  verified against `PermissionService.java`/`PolicyService.java`); the exact
  filtering semantics of `GET .../policy?name=&type=role`.
- **`default-roles`**: whether `POST`/`DELETE /roles-by-id/{id}/composites`
  truly accepts a bare `{id, name}` ref array (this app assumes the same shape
  the realm role-mappings endpoint uses, per `groups/_shared.ts`).
- **`authentication-flows`**: whether `PUT /authentication/flows/{id}` ignores
  an included `providerId` (this app never sends a changed one, so it never
  tests the server's actual behavior either way).
- **`required-actions`**: that a freshly `register-required-action`'d alias is
  immediately queryable at `GET /required-actions/{alias}` with no
  propagation delay.
- **`user-federation`**: whether `PUT /components/{id}` leaves an omitted
  config key untouched rather than clearing it — the load-bearing assumption
  behind stripping `bindCredential`/`keyTab` from every rollback/merge body
  instead of re-sending them.
- **`client-scopes`**: whether `PUT /default-{default,optional}-client-scopes/{id}`
  truly accepts no request body.

## Pipeline handlers (every config type)

- **validate** — static field/format checks (identity presence + pattern,
  known enum values, JSON-shape checks for the JSON-textarea escape-hatch
  fields); no live target access.
- **deploy** — upsert by the type's stable identity; resolves any referenced
  object (client, realm role, client scope, …) to its live id first, failing
  the item with a named, actionable error if the reference doesn't resolve.
- **rollback** — restore prior managed fields or delete a created resource;
  never replays a masked secret placeholder.
- **healthCheck** — token-authenticated realm reachability (shared across
  every config type via `lib/health.ts`).
- **driftDetect** — compare managed fields vs. live, per item, best-effort
  (a reference that can't be resolved is skipped, never asserted as drift).
- **getStatus** — deployment status from platform records (shared via
  `lib/status.ts`).

## Development

```
cd apps/keycloak
node node_modules/typescript/bin/tsc --noEmit    # typecheck
node ../../scripts/test-apps.mjs keycloak        # run handler tests
node ../../scripts/validate-app.mjs apps/keycloak # validate against the app contract
```

## BYOL infrastructure hosting

Beyond configuring an existing Keycloak instance, this app can provision and
manage a dedicated Keycloak stack end to end (bring-your-own-license): define a
topology, deploy to a Veltrix-hosted or your own cloud account, then manage its
lifecycle from the **Infrastructure** page (Config nav group). One
user-scalable **Keycloak nodes** tier (Infinispan-clustered, behind the load
balancer on HTTP 8080 / HTTPS 8443) plus a fixed single **PostgreSQL**
datastore. See the [changelog](CHANGELOG.md)'s 0.3.0 entry for the full detail
— unchanged by this release.

## Accuracy note

This app's config-as-code surface (16 types) is independent of its BYOL
infrastructure hosting — they happen to target the same instance once
deployed, but neither depends on the other. See **Coverage** above for the
config surface's citations and open verification items; see the 0.3.0
changelog entry for the BYOL topology's own caveats.
