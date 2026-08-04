# 🛡️ Wazuh

Manage [Wazuh](https://wazuh.com) — the open-source SIEM / XDR / HIDS platform —
as code on the Veltrix Security-as-Code platform. Author configuration in the
Configuration Canvas and drive it through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status), with BYOL cluster
infrastructure groundwork.

## How it's managed

Wazuh is managed entirely over its **REST API on port 55000**. The manager ships
a self-signed certificate by default (tolerated by the transport), and auth is a
two-step token flow:

1. `POST /security/user/authenticate` with HTTP Basic (API username/password)
   → `{ data: { token } }`.
2. Every subsequent call carries `Authorization: Bearer <token>`.

Tokens are short-lived, so each pipeline run re-authenticates. There is no
Salt/SSH remote-command seam — everything is REST.

## Configuration types

10 configuration types, grouped in the Configuration Canvas:

| Group | Type | Surface |
|---|---|---|
| Lists & Data | **CDB Lists** | `PUT /lists/files/{filename}` |
| Agents | **Agent Groups** | `POST /groups` + `PUT /groups/{group}/configuration` |
| Ruleset | **Custom Rules** | `PUT /rules/files/{filename}` |
| Ruleset | **Custom Decoders** | `PUT /decoders/files/{filename}` |
| Manager | **Manager Configuration** | `PUT /manager/configuration` (whole `ossec.conf`) |
| Security & Access | **API Users** | `POST`/`PUT /security/users` + `run_as`/`roles` relationships |
| Security & Access | **API Roles** | `POST`/`PUT /security/roles` + `policies`/`rules` relationships |
| Security & Access | **API Policies** | `POST`/`PUT /security/policies` |
| Security & Access | **RBAC Rules** | `POST`/`PUT /security/rules` |
| Security & Access | **API Security Settings** | `PUT`/`DELETE /security/config` |

CDB lists are constant databases — newline-separated `key:value` lookup files that
rules/decoders consult for O(1) membership/enrichment (blocklists, allowlists,
reputation). Field mapping: `listName` + `path` identify the file, `entries` is
the CDB body, `comment` is audit-only (CDB files hold no inline comments).

See **Coverage** below for the full per-type API accounting and what was
intentionally excluded.

## BYOL infrastructure

`infra/spec.ts` declares the cluster (`manager-master` / `manager-worker` /
`indexer` / `dashboard`) as a declarative `InfraSpec` composed from the generic
OpenTofu modules — no tool-specific HCL. The ALB fronts the dashboard (HTTPS 443);
the manager API (55000), agent (1514/1515), cluster (1516) and indexer
(9200/9300) ports are opened per role. The generic provisioning worker runs
`infra/bringup/wazuh-setup.mjs` after `tofu apply`, gating readiness on the
indexer cluster + manager API + dashboard.

## Development

```
cd apps/wazuh
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs wazuh            # run handler tests
node ../../scripts/validate-app.mjs apps/wazuh    # validate against the app contract
```

## Coverage (v0.5.0)

Coverage was audited against the Wazuh API OpenAPI spec
(`api/api/spec/spec.yaml`, tag `v4.14.7`, [github.com/wazuh/wazuh](https://github.com/wazuh/wazuh))
— every `PUT`/`POST`/`DELETE` path in the spec was reviewed for whether it
describes genuinely-declarative, durable configuration. Field-level grammar
(RBAC action/resource regexes, `names` format, password requirements) was
cross-checked against `framework/wazuh/rbac/orm.py` and `api/api/validator.py`
in the same tag.

### Managed declarative configuration

| Configuration type | Wazuh REST API operations |
| --- | --- |
| CDB Lists | `GET`/`PUT /lists/files/{filename}` (raw CDB body, `overwrite=true`) |
| Agent Groups | `PUT /groups?group_id=` (create) + `GET`/`PUT /groups/{group_id}/configuration` (shared `agent.conf`) |
| Custom Rules | `GET`/`PUT /rules/files/{filename}` (raw ruleset XML); best-effort `PUT /manager/restart` to activate |
| Custom Decoders | `GET`/`PUT /decoders/files/{filename}` (raw decoder XML); best-effort `PUT /manager/restart` to activate |
| Manager Configuration | `GET`/`PUT /manager/configuration` (whole `ossec.conf`, `raw=true` round-trip); best-effort `GET /manager/configuration/validation` + `PUT /manager/restart` |
| API Users | `GET`/`POST /security/users`, `PUT /security/users/{id}` (password), `PUT /security/users/{id}/run_as`, `POST`/`DELETE /security/users/{id}/roles` |
| API Roles | `GET`/`POST /security/roles`, `POST`/`DELETE /security/roles/{id}/policies`, `POST`/`DELETE /security/roles/{id}/rules` |
| API Policies | `GET`/`POST /security/policies`, `PUT /security/policies/{id}` (`{ actions, resources, effect }`) |
| RBAC Rules | `GET`/`POST /security/rules`, `PUT /security/rules/{id}` (FIND/MATCH condition tree) |
| API Security Settings | `GET`/`PUT`/`DELETE /security/config` (`auth_token_exp_timeout`, `rbac_mode`) |

Every id-keyed security resource (users/roles/policies/rules) is upserted by
its human NAME — Wazuh's own numeric id is resolved by listing and matching
client-side (`lib/wazuhApi.ts`'s `listAffectedItems`), since these resources
have no lookup-by-name endpoint. Many-to-many relationships (a role's
policies/rules, a user's roles) are declared as the owning item's COMPLETE set
and reconciled to match exactly on every deploy (add what's missing, detach
what's no longer declared) — the same declarative full-replace philosophy as
the whole-file config types. As with every config type in this app, an object
not declared in ANY canvas is left alone (no cross-resource pruning) — only a
role/user's own declared relationship set is fully reconciled.

### Intentionally excluded

- **Per-agent / device-scale operations**: agent registration and key issuance
  (`POST /agents/insert*` — generates a secret enrollment key), single-agent
  group membership (`PUT`/`DELETE /agents/{id}/group*`, `PUT /agents/group`),
  restarts/reconnects/upgrades (`PUT /agents/{id}/restart`, `/agents/restart`,
  `/agents/upgrade*`, `/agents/reconnect`, `/agents/group/{id}/restart`,
  `/agents/node/{id}/restart`), and agent uninstall/deletion (`DELETE /agents`,
  `GET /agents/uninstall`). These fan out across a dynamic, per-tenant agent
  fleet rather than a stable canvas-owned resource — the same reasoning the
  Cisco Meraki app uses to exclude per-device configuration.
- **Group files beyond `agent.conf`**: `GET /groups/{group_id}/files` and
  `GET /groups/{group_id}/files/{file_name}` (`ar.conf`, `merged.mg`,
  `rootkit_files.txt`, RCL check files, …) are read-only via the API — there is
  no `PUT` for them. Only `agent.conf` is writable (already covered by Agent
  Groups).
- **Cluster/service actions**: `PUT /cluster/restart`, `/manager/restart` (used
  internally as a best-effort side-effect after a ruleset/manager-config
  change, not exposed as its own config type), `/cluster/analysisd/reload`,
  `/manager/analysisd/reload`, and `PUT /security/user/revoke` (revoke every
  issued token) are imperative operations, not durable desired state.
- **Scan/test actions**: `PUT /rootcheck`, `/syscheck`, `DELETE
  /rootcheck/{id}`, `/syscheck/{id}`, `/experimental/rootcheck`,
  `/experimental/syscheck` (run or clear a scan database) and `PUT /logtest` +
  `DELETE /logtest/sessions/{token}` (an ephemeral rule-testing session) are
  one-shot actions/utilities, not configuration.
- **Event ingestion**: `POST /events` submits a synthetic log event into the
  manager — a write, but not configuration.
- **Cluster identity**: `GET /cluster/local/config` (node name/type/key/peer
  list) and the API's own transport settings (`GET /manager/api/config`,
  `GET /cluster/api/config` — `api.yaml`'s host/port/CORS/TLS/rate-limit
  settings) are read-only via the REST API; both require local file access
  (`cluster.json`/`api.yaml`) and a service restart, outside this app's
  connection-scoped credential model.
- **`/cluster/{node_id}/configuration`**: the same whole-`ossec.conf` write as
  Manager Configuration, but addressed by node name through another node's API
  (for pushing a peer's config remotely). This app instead targets each
  manager/manager-master/manager-worker component directly via its own
  `hostname:port`, consistent with every other config type here — the
  node-addressed variant is unused by design, not unsupported.
- **Alerts, events, agent inventory/stats, MITRE ATT&CK reference data,
  syscollector, SCA, CIS-CAT, rootcheck/syscheck results, logs, and task
  status** are all read-only monitoring/reporting endpoints — never
  configuration.
- **RBAC action/resource catalogs** (`GET /security/actions`,
  `GET /security/resources`) are read-only reference lists; API Policies'
  `actions`/`resources` fields point operators at them in their help text
  rather than re-implementing the catalog client-side.

Primary references: the Wazuh API OpenAPI spec
([api/api/spec/spec.yaml](https://github.com/wazuh/wazuh/blob/v4.14.7/api/api/spec/spec.yaml)),
the RBAC grammar in
[framework/wazuh/rbac/orm.py](https://github.com/wazuh/wazuh/blob/v4.14.7/framework/wazuh/rbac/orm.py),
and the custom OpenAPI format checkers in
[api/api/validator.py](https://github.com/wazuh/wazuh/blob/v4.14.7/api/api/validator.py) — all
pinned to tag `v4.14.7`.

## Notes

Wazuh 4.x API paths (`/security/user/authenticate`, `/lists/files/{filename}`,
`/manager/status`) follow the documented conventions; verify against your build.
The `/lists/files` upload takes the raw CDB file as an octet-stream and the
filename is relative to the ruleset lists dir (`etc/lists/`). The RBAC
relationship endpoints (`.../policies`, `.../rules`, `.../roles`) attach in
call order, not necessarily the declared list order — Wazuh's policy-priority
`position` query parameter is not managed by this app.

Apache-2.0.
