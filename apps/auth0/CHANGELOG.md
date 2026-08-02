# Changelog

All notable changes to the Auth0 app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Applications (Clients)** config type — create / edit / delete Auth0
  applications (name, application type, callback / logout / web-origin URLs, token
  endpoint auth method) over the Auth0 Management API v2, with validate / deploy
  (upsert by client name) / rollback (restore prior fields or delete a created
  client) / health-check / drift-detect / status.
- **Connectivity test** — mints a Management API access token via the OAuth2
  client-credentials grant (`POST /oauth/token`, audience
  `https://<tenant>/api/v2/`) and calls `GET /api/v2/clients?per_page=1`.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (M2M
  application → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for an Auth0 tenant; saving a connection registers
  `auth0-tenant` as a deploy target).

> Auth0's Management API keys clients on the server-assigned `client_id`, so this
> config type upserts by application **name**. The connection stores the
> Machine-to-Machine credential as Client ID (username) + Client Secret (token).
