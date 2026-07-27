# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.5.0 — 2026-07-26

### Added
Twelve new configuration types, each with the full pipeline handler set
(validate, deploy, rollback, drift detection, health check, status). All are
name/site-keyed with the object id stored for rename-safety, reconcile only
deletes what the app created, and none needs a separate deploy/apply step.

- **NPA Policy Groups** — named NPA rule-group containers. Built-in groups
  (`can_be_edited_deleted=false`) are preserved and never modified or deleted.
  Backed by `/api/v2/policy/npa/policygroups`.
- **NPA Policy Rules** — private-app policy rules (action, private apps/tags,
  users, groups, access methods, device classifications and network scoping).
  The policy group is given by name and resolved to a `group_id`; a PUT sends the
  full spec; create is eventually-consistent and retried. Backed by
  `/api/v2/policy/npa/rules`.
- **DNS Security Profiles** — logging plus `domain_config`, `tunnel_config` and
  `custom_config` as validated JSON. PATCH auto-deploys; `business_categories`
  are never sent; the first list call is retried past a "migration in progress"
  400. Backed by `/api/v2/profiles/dns`.
- **Destination Profiles** — network-location profiles (match type, destination
  values and RBAC labels resolved by name to `label_ids`). Backed by
  `/api/v2/profiles/destinations`.
- **GRE Tunnels** — branch connectivity keyed on `site`, with source IP, POP
  names (validated against the live GRE POPs), bandwidth and XFF options. Backed
  by `/api/v2/steering/gre/tunnels`.
- **IPSec Tunnels** — branch connectivity keyed on `site`, with a write-only
  pre-shared key (re-sent every deploy, never compared for drift), encryption,
  POP names (validated) and IKE options. Backed by
  `/api/v2/steering/ipsec/tunnels`.
- **Publisher Upgrade Profiles** — NPA publisher auto-upgrade schedules (release
  channel, docker tag, 5-field CRON and timezone), keyed on name with the
  `external_id` stored. Backed by `/api/v2/infrastructure/publisherupgradeprofiles`.
- **NPA Local Brokers** — local brokers (public-IP access mode, IP overrides,
  RBAC labels resolved by name and geo metadata); runtime registration state is
  ignored. Backed by `/api/v2/infrastructure/lbrokers`.
- **AI Gateway Providers** — custom AI providers (schema, host, port, protocol)
  with a write-only certificate. Backed by `/api/v2/aig/aiproviders`.
- **AI Gateway MCP Servers** — custom MCP servers (host, port, path, protocol,
  optional tools/resources/prompts filters) with a write-only certificate.
  Backed by `/api/v2/aig/mcpservers`.
- **AI Gateway Rate Limits** — rate-limit rules with match criteria and threshold
  managed as validated JSON, appliance scoping and a custom response. Backed by
  `/api/v2/aig/ratelimits`.
- **AI Gateway Token Groups** — API token group containers (name + description;
  not the per-token secrets). Backed by `/api/v2/aig/tokengroups`.
- `extractProfileObject` helper in the Netskope API client for the profiles
  family (`/profiles/*`), whose create and GET-by-id responses return the bare
  object with no `{status, data}` envelope.

## 0.4.0 — 2026-07-26

### Added
- **NPA Publishers** configuration type — manage Netskope Private Access
  publishers (name + local broker connect) as code, with the full pipeline
  handler set. Publishers are id-addressed with no lookup-by-name, so the app
  matches by name and stores the publisher_id for rename-safety; updates use
  PATCH with no deploy/apply step; reconcile only deletes publishers this app
  created. Backed by `/api/v2/infrastructure/publishers`.
- **Private Apps** configuration type — manage Netskope Private Access private
  apps (host, TCP/UDP protocols, publishers and access options) as code, with
  the full pipeline handler set. Apps are id-addressed with no lookup-by-name, so
  the app matches by app_name and stores the id for rename-safety; a PUT sends
  the full desired spec each deploy (no deploy/apply step); declared publisher
  names/ids are resolved against the live publisher inventory; reconcile only
  deletes apps this app created. Backed by `/api/v2/steering/apps/private`.
- `getAllNpa`, `extractNpaList` and `extractNpaObject` helpers in the Netskope
  API client for the NPA `{status, data}` response envelope.

## 0.3.0 — 2026-07-26

### Added
- **RBAC Labels** configuration type — manage Netskope RBAC labels (name +
  color) as code, with the full pipeline handler set. Labels are id-addressed
  with no lookup-by-name, so the app matches by name and stores the id for
  rename-safety; updates use PATCH with no deploy/apply step; reconcile only
  deletes labels this app created.
- `PATCH` support in the Netskope API client.

## 0.2.0 — 2026-07-26

### Added
- **Device Classification Tags** configuration type — manage Netskope device
  classification tags (name + description) as code, with the full pipeline
  handler set. Tags are id-addressed with no lookup-by-name, so the app matches
  by name and stores the id for rename-safety; updates use PUT with no
  deploy/apply step; reconcile only deletes tags this app created.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Netskope REST API v2 client (`lib/netskope.ts`) with
  `Netskope-Api-Token` header auth, limit/offset pagination and 429 backoff.
- **URL Lists** configuration type — manage Netskope URL lists (exact URLs/IPs or
  regex patterns) as code, with the full pipeline handler set: validate, deploy,
  rollback, drift detection, health check and status. Lists are id-addressed with
  no lookup-by-name, so the app matches by name and stores the id after deploy for
  rename-safety; a PUT replaces the whole list; reconcile only deletes lists this
  app created. Changes are staged and then applied with a single `deploy` call
  (which applies all pending url-list changes on the tenant).
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the REST API v2 token credential and the `netskope` deploy
  target.
- Connection test (`handlers/testConnection.ts`) verifying the token against
  `GET /api/v2/policy/urllist`.
