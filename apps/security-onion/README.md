# 🧅 Security Onion

Manage [Security Onion](https://securityonion.net) — the open-source Network
Security Monitoring / SIEM platform — as code on the Veltrix Security-as-Code
platform. Author grid configuration in the Configuration Canvas and drive it
through the pipeline (validate → deploy → rollback → health-check → drift-detect
→ status), with BYOL infrastructure provisioning.

## How it's managed

Security Onion has no single configuration API — the **manager** owns the grid via
**Salt**. This app applies configuration two ways:

- **Salt / `so-*` CLI over managed ZTNA** (`ctx.remote.command`) — Suricata rule
  state, firewall/analyst access, SOC users, Zeek. The app declares its command
  vocabulary in `manifest.yaml` (`remoteCommands`); the platform validates every
  parameter and shell-quotes it. Requires managed connectivity to the manager.
- **HTTPS REST** — the SOC console / Kibana detection engine (443) and
  Elasticsearch (9200) for detections and index-lifecycle management. Self-signed
  certificates are tolerated.

See [`DATAFLOW.md`](./DATAFLOW.md) for how each operation routes to completion.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Suricata Rules** | `so-rule` + Salt highstate | ✅ v0.1.0 |
| Firewall / Analyst Access | `so-firewall` | planned |
| SOC Users | `so-user` | planned |
| Detections | Kibana/Elastic detection engine (REST) | planned |
| Elastic ILM | Elasticsearch (REST) | planned |
| Zeek | Salt | planned |

## BYOL infrastructure

`infra/spec.ts` declares the grid (manager / manager-search / search / sensor /
forward / fleet / receiver / heavy / idh / standalone) as a declarative
`InfraSpec` composed from the generic OpenTofu modules — no tool-specific HCL. The
generic provisioning worker runs `infra/bringup/so-setup.mjs` (Salt `so-setup`)
after `tofu apply`, gating readiness on the Elastic cluster and SOC.

## Notes

Security Onion 2.4 command paths (`/usr/sbin/so-*`, `salt-call`) follow the
documented conventions; verify against your grid. The managed-ZTNA remote path is
gated by the platform's `REMOTE_EXEC_ENABLED` flag.

Apache-2.0.
