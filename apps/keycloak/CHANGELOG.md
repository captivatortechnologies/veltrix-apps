# Changelog

All notable changes to the Keycloak app are documented here.

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
