# Changelog

All notable changes to the Keycloak app are documented here.

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
