# Changelog

All notable changes to the authentik app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
