# Changelog

All notable changes to the Twingate app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added
- **Connectors (`connectors`, group "Network").** Declarative Connector
  registration, rename/delete, immutable Remote Network placement and status
  notification preference through `connectorCreate` / `connectorUpdate` /
  `connectorDelete`. A Connector's Remote Network is set on create only
  (`connectorUpdate` has no such argument) — a declared move fails closed
  rather than being silently ignored or attempted via an unsupported mutation.
- **DNS Filtering Profiles (`dns-filtering-profiles`, group "Security").**
  Manage Twingate DNS Filtering Profiles as code through
  `dnsFilteringProfileCreate` / `dnsFilteringProfileUpdate` /
  `dnsFilteringProfileDelete`, reconciled by name. `dnsFilteringProfileCreate`
  accepts only `name` — creating a new profile always create-then-immediately-
  updates to apply the rest of the declared spec (priority, fallback method,
  allow/deny domain lists, every content/security/privacy category flag, and
  Group assignment matched by name, full-replacement).
- A schema/provider-source **Coverage** section in the README documenting
  every managed Twingate mutation family and every intentionally EXCLUDED
  surface with its reason (one-time credentials, IdP-owned identity,
  externally-managed groups, read-only objects, runtime/telemetry state).

### Fixed
- Corrected a prior (incorrect) Coverage note claiming DNS Filtering Profiles
  had no stable, documented CRUD mutations — `dnsFilteringProfileCreate` /
  `Update` / `Delete` are confirmed via terraform-provider-twingate's tested
  Go GraphQL client and are now managed (see above).

### Security
- Connector token generation and DNS Filtering Profile category content
  remain the only two write paths this app touches for these objects; Connector
  runtime tokens are explicitly EXCLUDED (see README Coverage) — they are
  one-time bearer credentials with no declarative desired state to diff or
  safely roll back.

## 0.2.0 — 2026-08-02

### Added
- **Remote Networks (`remote-networks`, group "Network").** Manage Twingate
  Remote Networks as code through `remoteNetworkCreate` / `remoteNetworkUpdate`
  / `remoteNetworkDelete`, reconciled by name. Each network declares a
  `location` (`OTHER` / `AWS` / `AZURE` / `GOOGLE_CLOUD` / `ON_PREMISE`,
  informational), a `network_type` (`REGULAR` / `EXIT`) and active state. The
  list query alone carries the full managed state, so no separate per-id read
  is needed for rollback capture.
- **Groups (`groups`, group "Access").** Manage Twingate Groups as code
  through `groupCreate` / `groupUpdate` / `groupDelete`, reconciled by name —
  matched ONLY among `MANUAL` groups. A same-named `SYNCED` (IdP-synced) or
  `SYSTEM` (Twingate built-in, e.g. "Everyone") group is never modified;
  deploy/drift report it as an error/critical diff instead of silently
  skipping or duplicating it. Each group declares active state and the
  Resources (matched by name) it grants access to, full-replacement — the
  same declarative model as Resources' `group_names`.
- **Service Accounts (`service-accounts`, group "Access").** Manage Twingate
  Service Accounts as code through `serviceAccountCreate` /
  `serviceAccountUpdate` / `serviceAccountDelete`, reconciled by name — the
  only field the API exposes as mutable.
  - **Out of scope (deliberately):** Service Account **keys**
    (`serviceAccountKeyCreate`/`Update`/`Delete`/`Revoke`). A key is a
    downloadable credential generated once with no readable value to diff
    against a declared spec, and rotating one from a config-as-code pipeline
    risks breaking a running workload with no "desired state" to reconcile
    to — manage keys directly in Twingate.
- **Sidebar `group:` on every configuration type**, including `resources`
  (now grouped under "Network" alongside `remote-networks`; `groups` and
  `service-accounts` are grouped under "Access") — the Configuration Canvas
  sidebar now clusters this app's 4 types into two collapsible sub-sections
  instead of a flat list.
- All three new types ship the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus) and reuse the existing `lib/twingateApi.ts`
  GraphQL client (`X-API-KEY`, 429 retry/backoff, `{ok,error,entity}` handling).

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
