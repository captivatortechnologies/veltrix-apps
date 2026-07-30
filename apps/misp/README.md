# 🧩 MISP

Manage [MISP](https://www.misp-project.org) — the open-source Threat Intelligence
Platform — as code on the Veltrix Security-as-Code platform. Author threat-intel
configuration in the Configuration Canvas and drive it through the pipeline
(validate → deploy → rollback → health-check → drift-detect → status), with BYOL
infrastructure provisioning.

## How it's managed

MISP exposes a single, uniform **REST API** over HTTPS (443). This app applies
configuration over that API:

- **HTTPS REST** — feeds and other objects via the MISP REST API. Authentication
  is a MISP **automation key** carried verbatim in the `Authorization` header (no
  Bearer prefix), stored as the connection credential's API token. MISP commonly
  ships a **self-signed certificate**, which the transport tolerates.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Threat Feeds** | MISP REST API (`/feeds`, `/feeds/add`, `/feeds/edit/{id}`) | ✅ v0.1.0 |
| Taxonomies | `/taxonomies` | planned |
| Warninglists | `/warninglists` | planned |
| Sharing Groups | `/sharingGroups` | planned |
| Organisations | `/admin/organisations` | planned |
| Sync Servers | `/servers` | planned |

The feed URL is the stable identity used to upsert (add vs edit) and to detect
drift; deploy snapshots the prior feed body so rollback can restore it (or disable
a feed it created).

## BYOL infrastructure

`infra/spec.ts` declares the MISP stack (`misp-core` web/API + workers,
`database` MariaDB, `redis`, and an all-in-one `standalone`) as a declarative
`InfraSpec` composed from the generic OpenTofu modules — no tool-specific HCL. The
generic provisioning worker runs `infra/bringup/misp-setup.mjs` after `tofu apply`,
gating readiness on the MISP web UI + workers.

## Notes

MISP REST API paths (`/servers/getVersion`, `/feeds`, `/feeds/add`,
`/feeds/edit/{id}`) follow MISP 2.4 conventions; **verify against a live MISP 2.4
instance**. TLS verification is off by default (self-signed) and configurable via
the `verify_tls` setting.

Apache-2.0.
