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

| Type | Surface | Status |
|---|---|---|
| **CDB Lists** | `PUT /lists/files/{filename}` (REST 55000) | ✅ v0.1.0 |
| Agent Groups + `agent.conf` | `PUT /groups/{group}/configuration` | planned |
| Custom Rules | `PUT /rules/files/{filename}` | planned |
| Custom Decoders | `PUT /decoders/files/{filename}` | planned |
| Integrations | `PUT /manager/configuration` (ossec.conf `<integration>`) | planned |

CDB lists are constant databases — newline-separated `key:value` lookup files that
rules/decoders consult for O(1) membership/enrichment (blocklists, allowlists,
reputation). Field mapping: `listName` + `path` identify the file, `entries` is
the CDB body, `comment` is audit-only (CDB files hold no inline comments).

## BYOL infrastructure

`infra/spec.ts` declares the cluster (`manager-master` / `manager-worker` /
`indexer` / `dashboard`) as a declarative `InfraSpec` composed from the generic
OpenTofu modules — no tool-specific HCL. The ALB fronts the dashboard (HTTPS 443);
the manager API (55000), agent (1514/1515), cluster (1516) and indexer
(9200/9300) ports are opened per role. The generic provisioning worker runs
`infra/bringup/wazuh-setup.mjs` after `tofu apply`, gating readiness on the
indexer cluster + manager API + dashboard.

## Notes

Wazuh 4.x API paths (`/security/user/authenticate`, `/lists/files/{filename}`,
`/manager/status`) follow the documented conventions; verify against your build.
The `/lists/files` upload takes the raw CDB file as an octet-stream and the
filename is relative to the ruleset lists dir (`etc/lists/`).

Apache-2.0.
