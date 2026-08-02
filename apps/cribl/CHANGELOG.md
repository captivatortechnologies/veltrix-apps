# Changelog

All notable changes to the Cribl app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Pipelines** config type — create / edit / delete Cribl Stream pipelines (an
  id, a target Worker Group / Edge Fleet, and the Function chain as conf JSON) over
  the Cribl REST API (`/api/v1[/m/<group>]/pipelines`), with validate / deploy
  (upsert by pipeline id) / rollback (restore prior or delete created) /
  health-check / drift-detect / status.
- **Access seam** (`lib/criblApi.ts`) — worker-group-aware REST client with
  on-prem login (`POST /api/v1/auth/login` → Bearer) or Cribl.Cloud/direct Bearer
  token, self-signed TLS tolerated.
- **Connectivity test** — obtain a Bearer (login or token), then
  `GET /api/v1/system/info` (HTTPS, self-signed tolerated).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (credential → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Cribl endpoint; saving a connection registers
  `cribl-leader` as a deploy target).

> Cribl REST API paths and the pipeline JSON shape follow the documented Cribl API
> and should be verified against a live Cribl. TLS verification is off by default
> (self-signed) and configurable via the `verify_tls` setting.
