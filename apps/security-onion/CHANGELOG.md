# Changelog

All notable changes to the Security Onion app are documented here.

## 0.6.0 — 2026-08-05

Research-first exhaustion pass: two more config types on the generic Elastic
Stack REST surface this app already uses (the same non-SO-specific Kibana/
Elasticsearch APIs `detections` and `elastic-ilm` already reach), plus a
documented Coverage section.

- **Elasticsearch Index Templates** — index patterns, shard/replica counts,
  and the ILM policy attached to new indices, via
  `PUT/GET/DELETE _index_template/<name>` on the Elasticsearch REST API
  (9200); the natural pairing for `elastic-ilm` (an index template's
  `index.lifecycle.name` is what attaches a custom retention policy to new
  indices). Manages CUSTOM templates for third-party/custom log sources, not
  Security Onion's own built-in templates.
- **Kibana Data Views** — the index patterns backing Discover, Dashboards and
  Hunt, via Kibana's own Data Views API (`/api/data_views/data_view`) reached
  at the SOC console's HTTPS port (443), the same way `detections` already
  reaches Kibana's Detection Engine API.
- Added a README **Coverage** section documenting what's managed, the
  Salt-pillar/BYOL boundary, and — after auditing SO 2.4's `so-user` CLI, the
  free NIDS "Tuning Overrides" UI, and the Pro/Hydra-licensed Connect API
  (`so-api-reference.html`) — exactly why detection tuning (threshold/
  suppress/modify), ruleset sources, and SOC user creation/roles are
  intentionally excluded rather than silently dropped.
- No CLI or Salt pillar surface was touched; `remoteCommands` is unchanged.

## 0.5.0 — 2026-07-30

Generic topology: BYOL dialog shows Security Onion tiers (Search nodes / Heavy
nodes) not Splunk labels; adds `node_tiers` storage (migration 004).

- Wired the app onto the SDK's generalized (app-declared N-tier) BYOL
  infrastructure manager: `client/pages/BYOLPage.tsx` now passes a `topology`
  prop declaring **Search nodes** (Elasticsearch data / search-node) and
  **Heavy nodes** (heavy-node search tier) instead of the SDK's former
  Splunk-only Indexers/Search-heads labels.
- `POST`/`PUT /byol` now read the generic `tiers: [{ key, count, placement }]`
  body shape (falling back to the legacy `indexerCount`/`searchHeadCount`/
  `indexerPlacement`/`searchHeadPlacement` fields when absent); distributed
  minimums are now expressed per tier (Search nodes ≥ 2, Heavy nodes ≥ 1) and
  validation errors name the tier.
- Added `node_tiers` (JSONB) to `so_byol_infrastructure` — the generic
  per-tier column the GET responses now expose as `tiers`, backfilled for
  existing rows; the legacy scalar columns are kept in sync for back-compat.

## 0.4.0 — 2026-07-29

BYOL infrastructure hosting (like Splunk Enterprise).

- **BYOL Infrastructure** page — provision and manage a Security Onion grid,
  wrapping the SDK `ByolInfrastructureManager`: create/list/detail, a topology
  **resource plan** (manager / search / sensor / forward / fleet nodes, derived
  from `infra/spec.ts`), deploy (emits a provisioning event for the generic
  worker), destroy, lifecycle (start/stop/restart), resources, deployments, and
  usage metering.
- App-owned store + routes under `/api/apps/security-onion/byol` (`so_byol_*`
  tables) adapted from splunk-enterprise; grid sizing is a reasonable default —
  verify against Security Onion deployment guidance.

> The BYOL form currently renders the SDK's generic node labels; the server maps
> them to Security Onion grid roles and the provisioned resource names are
> SO-correct. SO-specific form labels need an SDK enhancement (tracked).

## 0.3.0 — 2026-07-29

Client UI.

- **Overview** — what the app manages in a grid, rendered with the platform
  design system (fed by the app's `/meta` route).
- **Setup Guide** — SOC credential → connection → managed connectivity → author.
- **Connections** — wraps the SDK `ConnectionsManager` for the SOC manager
  (HTTPS 443); saving a connection registers the manager as a deploy target.

> The BYOL infrastructure **management console** (provision/list/deploy UI + its
> server routes) is a tracked follow-on; the declarative provisioning foundation
> (`infra/spec.ts` + Salt bring-up) is already in place and driven by the generic
> provisioning worker.

## 0.2.0 — 2026-07-29

Five more config types — the full six-type set.

- **Firewall Access** — include/exclude hosts in a Security Onion firewall host
  group via `so-firewall` (+ Salt highstate); inverse-undo rollback.
- **SOC Users** — enable/disable existing SOC Console users via `so-user`. (User
  creation + passwords are interactive/stdin and remain a follow-up.)
- **Zeek Configuration** — enable/disable Zeek log types via a declared command
  (representative — verify against a live grid; deep pillar config is a follow-up).
- **Detection Engine Rules** — create/update/delete Elastic/Kibana detection rules
  over the SOC console REST API (443) with drift + rollback.
- **Elasticsearch ILM Policies** — hot-rollover + retention ILM policies over the
  Elasticsearch REST API (9200) with drift + rollback.

Adds `remoteCommands` for `so-firewall`, `so-user`, and `zeek-toggle`, and app
permission resources for each new config type.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **Suricata Rules** config type — enable/disable NIDS rules by SID across the
  grid, applied on the manager via `so-rule` + a Salt highstate over managed ZTNA,
  with validate / deploy / rollback (inverse-undo) / health-check / status.
- **Connectivity test** against the SOC console (HTTPS, self-signed tolerated).
- **BYOL infrastructure** groundwork: declarative `infra/spec.ts` composing the
  generic OpenTofu modules (manager / search / sensor / forward / fleet grid) +
  Salt bring-up entrypoint.
- Uses the platform's new app-declared `remoteCommands` seam so Salt/CLI grid
  operations run over managed ZTNA with per-param validation.

> Grid config is applied via Salt (`so-*`, `salt-call`) and the SOC/Elasticsearch
> REST APIs. Remote command paths follow Security Onion 2.4 conventions and should
> be verified against your grid; the managed-ZTNA remote path ships behind the
> platform's `REMOTE_EXEC_ENABLED` flag.
