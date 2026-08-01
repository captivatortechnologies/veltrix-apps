# Changelog

All notable changes to the OpenCTI app are documented here.

## 0.1.0 — 2026-07-31

Initial release — foundation + first config type.

- **Marking Definitions** config type — add / edit / delete OpenCTI data-marking
  definitions (type, definition, color, order) over the OpenCTI GraphQL API, with
  validate / deploy (upsert by the `definition` value) / rollback (restore prior or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the OpenCTI GraphQL API (`about { version }`,
  fallback `me { id name }`, HTTPS, self-signed tolerated) using an OpenCTI API
  token carried as a Bearer token.
- **GraphQL seam** (`lib/openctiApi.ts`) — a self-signed-tolerant `node:https`
  client with a `graphql(query, variables)` helper and a version/connectivity probe.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API token →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for an
  OpenCTI instance; saving a connection registers `opencti-platform` as a deploy
  target).

> OpenCTI GraphQL operation + field names follow OpenCTI conventions and should be
> verified against a live OpenCTI instance (the `about { version }` probe, the
> `EditInput` value-as-string-list patch shape, and `MarkingDefinitionAddInput`
> fields). TLS verification is off by default (self-signed) and configurable via the
> `verify_tls` setting.
