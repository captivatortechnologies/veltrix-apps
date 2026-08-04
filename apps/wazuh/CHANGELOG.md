# Changelog

All notable changes to the Wazuh app are documented here.

## 0.5.0 — 2026-08-04

Exhausted the remaining genuinely-declarative Wazuh REST API config surface —
six new configuration types (10 total), grouped "Manager" and "Security &
Access". Coverage was audited against the Wazuh API OpenAPI spec
(`api/api/spec/spec.yaml`, tag `v4.14.7`, github.com/wazuh/wazuh) — every
`PUT`/`POST`/`DELETE` path in the spec was reviewed; see the README's new
**Coverage** section for the full accounting, including what was intentionally
dropped and why.

- **Manager Configuration** — the manager's entire `ossec.conf`, replaced
  whole-file (`GET`/`PUT /manager/configuration`, `raw=true` for a byte-faithful
  round-trip), same content-replace model as Custom Rules/Decoders. Deploy also
  calls `GET /manager/configuration/validation` (best-effort syntax check) and
  `PUT /manager/restart` (best-effort reload) and reports both in the result
  message.
- **API Users** — Wazuh REST API accounts: username/password (write-only,
  Wazuh never returns it), the `allow_run_as` flag, and the user's complete
  role set (by name, reconciled against `/security/users/{id}/roles`).
- **API Roles** — RBAC roles: name plus the role's complete policy and RBAC-rule
  sets (by name, reconciled against the `/security/roles/{id}/policies` and
  `/security/roles/{id}/rules` relationship endpoints).
- **API Policies** — RBAC policies: `actions` + `resources` + `effect`
  (allow/deny), validated against the exact `ACTION_REGEX`/`RESOURCE_REGEX`
  grammar in `framework/wazuh/rbac/orm.py`.
- **RBAC Rules** — authentication-context matching conditions (Wazuh's
  FIND/MATCH grammar) attached to roles — distinct from the ruleset "Custom
  Rules" config type, which manages `etc/rules` detection content.
- **API Security Settings** — the manager-wide `auth_token_exp_timeout` +
  `rbac_mode` singleton (`GET`/`PUT`/`DELETE /security/config`); rollback falls
  back to `DELETE` (Wazuh's own "restore defaults") when no prior snapshot
  could be captured.
- `lib/wazuhApi.ts` gained `listAffectedItems()`, a generic list-endpoint reader
  for the id-keyed security resources (users/roles/policies/rules), which —
  unlike the filename-keyed resources — have no lookup-by-name endpoint and
  must be resolved by listing and matching client-side.
- README gained a **Coverage** section auditing every config type against its
  Wazuh API operations, plus an honest accounting of what's intentionally
  excluded (per-agent runtime actions, secret-generating agent enrollment,
  read-only endpoints, session/token security actions) and why.

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
