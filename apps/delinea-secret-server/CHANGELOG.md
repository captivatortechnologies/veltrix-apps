# Changelog

All notable changes to the Delinea Secret Server app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Folders** config type — create / update Secret Server folders (folder name,
  parent folder, permission inheritance, secret-policy inheritance) over the
  Secret Server REST API (`/api/v1/folders`), with validate / deploy (upsert by
  folder name within a parent) / rollback (restore prior state) / health-check /
  drift-detect / status.
- **Connectivity test** against the Secret Server REST API — runs the OAuth2
  password grant (`POST <base>/oauth2/token`) then a lightweight authorized probe
  (`GET /api/v1/folders?take=1`). HTTPS, self-signed tolerated.
- **API seam** (`lib/secretServerApi.ts`) — OAuth2 password-grant bearer-token
  client over `node:https` (self-signed tolerated, toggled by the `verify_tls`
  setting), token cached for the handler's lifetime.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API user
  → connection → author), and Connections (wraps the SDK `ConnectionsManager` for
  a Secret Server instance; saving a connection registers `delinea-secret-server`
  as a deploy target).

> Secret Server REST API paths and folder fields (`/api/v1/folders`,
> `oauth2/token`, `folderName` / `parentFolderId` / `inheritPermissions` /
> `inheritSecretPolicy` / `folderTypeId`) follow the documented v1 REST API and
> should be verified against a live Secret Server instance. TLS verification is
> off by default (on-prem self-signed) and configurable via the `verify_tls`
> setting.
