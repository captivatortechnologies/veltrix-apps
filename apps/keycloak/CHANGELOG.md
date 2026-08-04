# Changelog

All notable changes to the Keycloak app are documented here.

## 0.4.0 — 2026-08-04

Exhausts the declarative surface of the Keycloak Admin REST API — twelve new
config types alongside the existing four (`clients`, `realm-roles`, `groups`,
`identity-providers`), each with the full validate / deploy / rollback /
health-check / drift-detect / status pipeline. Researched against the official
Keycloak Admin REST API docs, the `keycloak/terraform-provider-keycloak`
resource docs, and — for every field/endpoint flagged as verified — Keycloak's
own server source on GitHub. See the [README](README.md)'s **Coverage**
section for the full managed/excluded/follow-up accounting and citations.

- **Client Scopes** — name, protocol, consent/token/discovery attributes (`display.on.consent.screen`,
  `consent.screen.text`, `include.in.token.scope`, `include.in.openid.provider.metadata`,
  `gui.order` — verified against `ClientScopeModel.java`), plus realm
  default/optional assignment reconciled via `/default-{default,optional}-client-scopes/{id}`.
- **Protocol Mappers** — OIDC/SAML claim/attribute mappers attached to an
  existing client or client scope, identity resolved to the parent's internal
  UUID at deploy time.
- **Client Roles** — roles scoped to a client, mirroring Realm Roles with a
  `clientId`-resolved identity.
- **Default Roles** — a realm-wide singleton reconciling the realm's default
  composite role's children (realm + client roles) via
  `/roles-by-id/{id}/composites`; warns when an empty declared set would strip
  Keycloak's own `offline_access`/`uma_authorization` defaults.
- **Authentication Flows** — custom flow containers only (alias, description,
  provider type); refuses to touch a live `builtIn: true` flow; the
  execution/step graph inside a flow is a deliberate boundary, not authored
  here (matching the sibling `authentik` app's own Flow/FlowStageBinding
  split).
- **Required Actions** — enable/default/reorder the realm's required actions
  by alias, registering a known-but-unregistered provider via
  `/register-required-action` on first deploy.
- **Realm Settings** — a realm-wide singleton covering Tokens (lifespans,
  plain integer seconds — verified against `RealmRepresentation.java`), Login
  flags (with the `duplicateEmailsAllowed`/`loginWithEmailAllowed`
  mutual-exclusion check) and the raw password-policy DSL string.
  `rollbackData` persists only the narrow field subset this type authors —
  never the full realm representation, which embeds `smtpServer.password`.
- **Client Profiles** / **Client Policies** — the FAPI-style client-policies
  framework's named executor sets and condition sets, each a realm-wide
  whole-list singleton (one GET + one PUT covering every canvas item
  together, mirroring `cisco-meraki`'s ordered firewall-rule lists).
  Keycloak's built-in `globalProfiles`/`globalPolicies` are verified (against
  `ClientProfilesRepresentation.java`/`ClientPoliciesRepresentation.java`/`ClientPoliciesUtil.java`)
  to be safely — and necessarily — excluded from every PUT.
- **User Federation** — LDAP and standalone Kerberos user-storage providers as
  Keycloak Components. `bindCredential`/`keyTab` are write-only and are
  stripped from every captured prior state before a rollback or merge can
  replay it, so a masked `"**********"` placeholder can never overwrite a live
  secret. LDAP attribute keys, the vendor enum and the numeric `searchScope`
  encoding are verified against `LDAPConstants.java`/`LDAPConfig.java`.
- **Identity Provider Mappers** — attribute/role/group mappers on an existing
  identity provider instance, identity `(alias, name)`.
- **Authorization** — a client's fine-grained authorization services
  (resources, scopes, permissions, role-based policies) behind a `kind`
  selector, gated on the client already having authorization services
  enabled. Only `role`-type policies are built; `js`/`time`/`user`/`client`/
  `group`/`aggregate`/`regex` policies are a documented follow-up.
- **Shared helpers** — `lib/clients.ts` (client `clientId` → internal UUID
  resolution, reused by Client Roles, Protocol Mappers, Authorization) and
  `lib/fields.ts` additions (`readJsonObject`/`readJsonArray`/`parseJsonField`
  for the JSON-textarea escape-hatch fields used by Default Roles,
  Client Profiles/Policies and Authorization's role-policy roles list).

> See the README's **Coverage** section for the complete managed/excluded/
> not-yet-built accounting, including the specific fields and endpoints still
> flagged for live-Keycloak verification (e.g. the exact composites-endpoint
> ref shape, permission/policy update-by-id semantics).

## 0.3.0 — 2026-08-01

BYOL infrastructure hosting — provision and manage a dedicated Keycloak cluster
(bring-your-own-license) from Veltrix, mirroring the deployment console the other
BYOL apps ship.

- **Infrastructure page** — a new sidebar page (Config group) wraps the SDK
  `<ByolInfrastructureManager>` over this app's app-owned `/byol` routes: define
  the stack topology, preview a Terraform-style plan (add/change/destroy), deploy
  to a Veltrix-hosted or your own cloud account (BYOC), then manage its lifecycle
  (start / stop / restart / destroy) with a live resource plan + activity
  timeline.
- **Topology** — one user-scalable node tier, **Keycloak nodes** (`server`, min 1,
  Infinispan-clustered, behind the load balancer on HTTP 8080 / HTTPS 8443), plus
  a fixed single **PostgreSQL** datastore and the foundation (network, load
  balancer, DNS, TLS, secrets). A single deployment collapses to one all-in-one
  Keycloak node with PostgreSQL; a distributed deployment clusters the Keycloak
  servers against a dedicated PostgreSQL. **node_tiers-native**: node counts +
  cluster placement are persisted ONLY in a `node_tiers` JSONB column — there are
  no legacy indexer/search-head count columns.
- **Declarative infra** — `infra/spec.ts` declares the Keycloak stack (ports,
  ALB front door, DNS prefixes, WAF) as data for the SAME generic OpenTofu
  modules the other apps use — no tool-specific HCL.
- **Usage metering** — an append-only lifecycle state-event log + a daily,
  idempotent metered ledger (node-hours) is the foundation for usage-based cloud
  billing, exposed over `/byol/usage` and a `/byol/usage/collect` collector.
- **Schema** — two app-owned, `keycloak_`-prefixed migrations add the BYOL
  infrastructure, resource-plan, deployment-run/step, state-event and usage
  tables. New `byol` (read/write/delete) and `usage` (read/write) app permissions.

> Keycloak stack sizing (ports, clustering, health) is a reasonable default —
> verify against the official Keycloak server / high-availability guides
> (www.keycloak.org) before treating it as production-grade.

## 0.2.0 — 2026-08-01

Access management as code — three new config types, each with validate / deploy
(upsert by identity) / rollback / health-check / drift-detect / status.

- **Realm Roles** config type — add / edit / delete realm roles (name,
  description, composite flag) over `/admin/realms/{realm}/roles`. The role name
  is the identity and the `{role-name}` path segment; upsert reads
  `GET /roles/{role-name}`, then `POST /roles` (create) or
  `PUT /roles/{role-name}` (update). Rollback restores the prior role or deletes
  the one it created.
- **Groups** config type — add / edit / delete **top-level** realm groups (name,
  attributes, assigned realm roles) over `/admin/realms/{realm}/groups`. Attributes
  are single-valued (the canvas key/value map is wrapped into Keycloak's
  `Map<String,List<String>>`). Realm roles are reconciled authoritatively through
  the dedicated `/groups/{id}/role-mappings/realm` endpoint (a declared role must
  already exist). Sub-groups are deferred to a later wave.
- **Identity Providers** config type — add / edit / delete identity provider
  instances (alias, display name, provider type, enabled, provider config) over
  `/admin/realms/{realm}/identity-provider/instances`. The alias is the identity
  and `{alias}` path segment. Provider config is a free key/value map; keys
  containing `secret` are write-only and excluded from drift (Keycloak returns
  them masked).
- **Shared helpers** — added `lib/fields.ts` (canvas field readers, including a
  key/value-map reader), `lib/health.ts` (realm-reachable health check) and
  `lib/status.ts` (deployment-status resolver) so the new config types stay DRY.

> Endpoints and representations are verified against the official Keycloak Admin
> REST API (www.keycloak.org/docs-api/latest/rest-api — Roles, Groups, Role
> Mapper and Identity Providers resources). BYOL infrastructure hosting remains
> planned for a later wave.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Clients** config type — add / edit / enable / disable Keycloak OIDC/SAML
  clients (client ID, display name, protocol, enabled, public/confidential,
  standard flow, redirect URIs) over the Keycloak Admin REST API, with validate /
  deploy (upsert by clientId) / rollback (restore prior or delete the created
  client) / health-check / drift-detect / status.
- **Admin token auth** — obtains an OAuth2 admin access token from
  `POST /realms/{realm}/protocol/openid-connect/token`. Primary grant is
  client-credentials (admin service-account client-id + secret); an admin
  username/password grant against `admin-cli` is also supported. The token is
  carried as `Authorization: Bearer`.
- **Connectivity test** — obtains an admin token then reads the managed realm
  (`GET /admin/realms/{realm}`), HTTPS, self-signed tolerated (toggle with the
  `verify_tls` setting).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (admin
  service account → connection → author), and Connections (wraps the SDK
  `ConnectionsManager`; saving a connection registers `keycloak-realm` as a deploy
  target).
- **Settings** — `realm` (managed realm, default `master`), `auth_realm` (token
  realm, default `master`), `verify_tls` (default off).

> Keycloak Admin REST API paths and the token flow are cited from the official
> docs (www.keycloak.org/docs-api/latest/rest-api and the server-development
> guide). The exact ClientRepresentation field surface should be verified against
> a live Keycloak. BYOL infrastructure hosting (provision a Keycloak stack) is
> planned for a later wave.
