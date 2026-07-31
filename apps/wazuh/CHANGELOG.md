# Changelog

All notable changes to the Wazuh app are documented here.

## 0.4.0 — 2026-07-30

Generic topology: BYOL dialog shows Wazuh tiers (Indexers / Manager workers) not
Splunk search-head labels; adds `node_tiers` storage (migration 004).

- Wired the BYOL cluster form to the SDK's app-declared N-tier
  `ByolInfrastructureManager` (`topology` prop) instead of the SDK's previous
  fixed Splunk-shaped indexer/search-head pair — the New/Edit dialog and list
  table now read "Indexers" / "Manager workers" throughout.
- The create/update `POST`/`PUT /byol` body now sends a generic
  `tiers: [{ key, count, placement }]` array; `lib/byolInput.ts` unpacks it
  back into the indexer/manager-worker counts and placements the rest of the
  app already speaks (with a legacy-body fallback for older clients).
- New `node_tiers` JSONB column on `wazuh_byol_infrastructure`
  (migration `004_wazuh_byol_node_tiers.sql`), backfilled from the existing
  `indexer_count`/`search_head_count`/`indexer_placement`/`search_head_placement`
  columns, which are kept for back-compat. The GET DTO now includes an ordered
  `tiers` array alongside the legacy fields.

## 0.3.0 — 2026-07-29

BYOL infrastructure hosting — provision + manage a Wazuh cluster (manager-master /
manager-worker / indexer / dashboard). Client BYOLPage wraps the SDK
`ByolInfrastructureManager`; app-owned `/byol` routes + `wazuh_byol_*` tables
(migrations 002/003) with a topology resource plan, deploy (emits a provisioning
event), destroy, lifecycle, resources, deployments, and usage metering.

## 0.2.0 — 2026-07-29

Three more config types (all over the Wazuh REST API):

- **Agent Groups** — agent groups + their shared `agent.conf`.
- **Custom Rules** — custom ruleset files (`etc/rules`); a manager restart activates the change.
- **Custom Decoders** — custom decoder files (`etc/decoders`); manager restart to activate.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **CDB Lists** config type — manage Wazuh constant databases (`key:value` lookup
  files backing blocklists/allowlists) over the Wazuh REST API (55000), with
  validate / deploy / rollback (prior-body snapshot or delete) / health-check /
  drift-detect / status. Deploy PUTs the raw CDB body to
  `/lists/files/{filename}?overwrite=true`; drift compares live entries key-by-key.
- **Wazuh REST seam** (`lib/wazuhApi.ts`) — self-signed-tolerant `node:https`
  client with the two-step token flow (`/security/user/authenticate` → bearer).
- **Connectivity test** — authenticates against the Wazuh API (HTTPS 55000); a
  returned token means connected, 401 flags the credential.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API user →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for
  the Wazuh manager API).
- **BYOL infrastructure** groundwork — declarative `infra/spec.ts` composing the
  generic OpenTofu modules (`manager-master` / `manager-worker` / `indexer` /
  `dashboard` cluster) + a `wazuh-setup` bring-up entrypoint.

> Wazuh is managed purely over the REST API — there is no Salt/SSH remote-command
> seam. API paths follow Wazuh 4.x conventions and should be verified against your
> build (notably the `/lists/files` octet-stream upload and the GET serialization
> used for the rollback snapshot).
