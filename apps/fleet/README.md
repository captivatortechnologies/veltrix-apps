# 🚀 Fleet

Manage [Fleet](https://fleetdm.com) — the open-source **osquery** fleet-management
platform (endpoint visibility, vulnerability and device management) — as code on
the Veltrix Security-as-Code platform. Author configuration in the Configuration
Canvas and drive it through the pipeline (validate → deploy → rollback →
health-check → drift-detect → status), with BYOL infrastructure provisioning
groundwork.

## How it's managed

Fleet exposes a single HTTPS **REST API** rooted at `/api/v1/fleet`. This app
applies all configuration over that API — there is no Salt/CLI path (unlike
Security Onion):

- **HTTPS REST** — saved osquery queries via `/api/v1/fleet/queries`, authenticated
  with a Fleet **API token** (`Authorization: Bearer <token>`). Self-signed
  certificates are tolerated (self-hosted Fleet, or the default 8080 listener).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Saved Queries** | Fleet REST `/api/v1/fleet/queries` | ✅ v0.1.0 |
| Policies | `/api/v1/fleet/global/policies` (+ team) | planned |
| Teams | `/api/v1/fleet/teams` | planned |
| Labels | `/api/v1/fleet/labels` | planned |
| Agent Options / Config | `/api/v1/fleet/config` | planned |
| Query Packs | `/api/v1/fleet/packs` | planned |

## BYOL infrastructure

`infra/spec.ts` declares a Fleet stack (`fleet-server` / `database` (MySQL) /
`redis` / `standalone`) as a declarative `InfraSpec` composed from the generic
OpenTofu modules — no tool-specific HCL. The generic provisioning worker runs
`infra/bringup/fleet-setup.mjs` (fleetctl / server setup) after `tofu apply`,
gating readiness on `/healthz` and a successful DB migration.

## Notes

Fleet API paths and request/response shapes follow the documented fleetdm
conventions; **verify against your live Fleet (fleetdm) instance**. The API token
is an API-only user token (or a session token from `POST /api/v1/fleet/login`).

Apache-2.0.
