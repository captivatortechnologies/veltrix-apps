# Changelog

All notable changes to the Twingate app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-02

### Added
- **Resources (`resources`).** Manage Twingate Resources — private
  applications, hosts and subnets reachable through a Remote Network's
  Connector(s) — as code through `resourceCreate` / `resourceUpdate` /
  `resourceDelete`, reconciled by resource name. Each resource declares an
  address, its Remote Network (matched by name), TCP/UDP/ICMP protocol policy
  (`ALLOW_ALL` / `RESTRICTED` with port lists / `DENY_ALL`), visibility flags
  (Client list, browser shortcut) and Group-based access (matched by name,
  full-replacement semantics). Missing resources are created; existing ones
  are reconciled to the declared spec.
- Full handler set (validate, deploy, rollback, healthCheck, driftDetect,
  getStatus) backed by a small GraphQL client (`lib/twingateApi.ts`) that
  authenticates with a static `X-API-KEY` header, retries HTTP 429 with
  backoff (Twingate's default rate limit is 60 reads / 20 writes per minute),
  and checks both the GraphQL transport/`errors[]` AND the `{ ok, error }`
  business-level payload every Twingate resource mutation returns.
- Connections page (API key, network name endpoint) with a connectivity test
  handler that probes `{ remoteNetworks(first:1){edges{node{id}}} }`.
- Overview and Setup Guide pages.
