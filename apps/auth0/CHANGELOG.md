# Changelog

All notable changes to the Auth0 app are documented here.

## 0.2.0 — 2026-08-01

Three new configuration types, all over the Auth0 Management API v2 and upserting
by name (list → match by name → PATCH existing / POST new), with rollback,
health-check, drift-detect and status.

- **Connections** config type — Auth0 Connections (identity providers): name,
  strategy, display name, enabled clients and strategy `options` (free-form JSON)
  over `/connections`. `name` and `strategy` are set at creation and omitted from
  the update body (immutable). Secret-bearing option keys (`client_secret`, …) are
  excluded from drift comparison and from the rollback restore body so a live
  secret is never overwritten with Auth0's mask.
- **Resource Servers (APIs)** config type — Auth0 APIs: name, `identifier`
  (audience URI), scopes (authored as value → description pairs), signing algorithm
  and token lifetime over `/resource-servers`. The `identifier` is unique and
  immutable, so it is sent only on create and omitted from the update body.
- **Roles** config type — Auth0 RBAC roles: name, description and assigned API
  permissions over `/roles`, with permissions reconciled through the
  `/roles/{id}/permissions` sub-resource (GET current → POST additions → DELETE
  removals). Rollback restores the prior role body and prior permission grants, or
  deletes a role it created.

> Note: Auth0 marks `enabled_clients` on the connection object as deprecated in
> favour of `PATCH /connections/{id}/clients`; it is still accepted here for
> compatibility.

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
