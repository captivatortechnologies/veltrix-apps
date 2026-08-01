# Changelog

All notable changes to the Trend Micro Vision One app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Suspicious Objects** config type — add / update / remove Trend Vision One
  user-defined suspicious objects (type — domain / ip / url / fileSha1 /
  senderMailAddress —, value, scan action block/log, risk level, description and
  days to expiration) over the Vision One public REST API (v3.0,
  `/threatintel/suspiciousObjects`), with validate / deploy (upsert by object
  value) / rollback (restore prior or remove created) / health-check / drift-detect
  / status.
- **Connectivity test** against the Vision One public API
  (`GET /v3.0/threatintel/suspiciousObjects?top=1`, Bearer API token).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  Vision One tenant; saving a connection registers `trend-vision-one-tenant` as a
  deploy target).

> The add + list endpoints and Bearer auth are confirmed from the Trend Vision One
> Automation Center docs. The remove endpoint
> (`/threatintel/suspiciousObjects/delete`), the list-response envelope and the
> `daysToExpiration` units are inferred from v3.0 conventions and should be verified
> against a live Vision One tenant.
