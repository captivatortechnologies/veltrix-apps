# Changelog

All notable changes to the Velociraptor app are documented here.

## 0.1.0 — 2026-07-31

Initial release — foundation + first config type.

- **Custom Artifacts** config type — add / edit / delete Velociraptor custom VQL
  artifacts (name, type, description, artifact YAML) over the gRPC API (mutual
  TLS) by executing VQL, with validate / deploy (upsert by name via
  `artifact_set`) / rollback (restore prior definition or `artifact_delete`) /
  health-check / drift-detect / status.
- **gRPC/mTLS transport** (`lib/velociraptorApi.ts`) — resolves the api-client
  config bundle into CA cert / client cert / client key / connection string,
  builds a mutual-TLS gRPC channel, and runs VQL, all behind a swappable
  transport seam. Wire contract in `lib/velociraptor.proto`.
- **Connectivity test** against the Velociraptor gRPC API (`SELECT * FROM
  info()`) using the api-client config.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide
  (api-client config → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Velociraptor server; saving a connection registers
  `velociraptor-server` as a deploy target).

> The gRPC service/method, SSL target-name override, and VQL function names
> (`artifact_set` / `artifact_delete` / `artifact_definitions` / `info`) are
> flagged in code and should be verified against a live Velociraptor server.
