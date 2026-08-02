# Changelog

All notable changes to the Graylog app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Streams** config type — create / edit / resume / delete Graylog message streams
  (title, description, matching type, remove-from-default-stream, index set, rules)
  over the Graylog REST API (`/api/streams`), with validate / deploy (upsert by
  stream title, resume newly created streams) / rollback (restore prior body or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the Graylog REST API (`GET /api/system`, HTTP Basic,
  self-signed TLS tolerated) using a Graylog user or an access token.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (credential → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Graylog node; saving a connection registers `graylog`
  as a deploy target).

> Graylog REST API paths (`/api/system`, `/api/streams`, `/api/streams/{id}`,
> `/api/streams/{id}/resume`, `/api/system/indices/index_sets`) should be verified
> against a live Graylog instance. Every write carries the mandatory
> `X-Requested-By` CSRF header. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.
>
> **BYOL hosting** for the Graylog stack (Graylog server + OpenSearch/Elasticsearch
> + MongoDB) is planned for a later wave and is intentionally not part of this
> release — no database or infrastructure provisioning ships yet.
