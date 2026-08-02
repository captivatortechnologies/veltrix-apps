# Rubrik

Manage **Rubrik** (backup, ransomware recovery and data security) configuration
as code through the **Rubrik CDM** (Cloud Data Management) REST API.

- **Category:** COMPLIANCE
- **Version:** 0.2.0
- **Target component type:** `rubrik-cluster`

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **SLA Domains** | Backup policies — snapshot **frequencies** and **retention** per tier (hourly / daily / weekly / monthly), upserted by name | `GET`/`POST /api/v2/sla_domain`, `PATCH`/`DELETE /api/v2/sla_domain/{id}` |
| **Fileset Templates** | Reusable definitions of *what to back up* on a host — OS family plus **include / exclude / exception** paths (+ optional backup-script hooks), upserted by name | `GET`/`POST /api/v1/fileset_template`, `PATCH`/`DELETE /api/v1/fileset_template/{id}` |
| **Managed Volumes** | SLA-protected storage targets — **channels**, **size**, subnet, application tag and export host patterns, upserted by name (channels/size fixed at creation) | `GET`/`POST /api/internal/managed_volume`, `PATCH`/`DELETE /api/internal/managed_volume/{id}` |

Authoring happens in the platform's **Configuration Canvas**; every write to the
cluster goes through the pipeline handlers (validate → deploy → health check →
drift detect → rollback).

## Authentication

Rubrik CDM is reached over HTTPS with a **service-account session**:

1. `POST /api/v1/service_account/session` with `{ "serviceAccountId": "...", "secret": "..." }`
   returns `{ "token": "..." }`.
2. Every subsequent call carries `Authorization: Bearer <token>`.

Create the service account in the Rubrik cluster under
**Settings → Users & Roles → Service Accounts**, then store it as a Veltrix
credential:

- **Username** → the service account **id**
- **API token** → the service account **secret**

The cluster HTTPS address is the connection **endpoint** (e.g.
`https://rubrik.example.com`). Base URL: `https://<cluster>/api/`.

> Rubrik clusters commonly ship a **self-signed certificate**, so TLS
> verification is **off by default**. Enforce it with the `verify_tls` app
> setting once a trusted certificate is installed.

### Rubrik Security Cloud (Polaris) note

Rubrik also offers **Rubrik Security Cloud (RSC / Polaris)**, whose control plane
is a **GraphQL** API authenticated with an **RSC service account**
(`clientId` / `clientSecret` at `/api/client_token`). This app implements the
**CDM REST** path for v0.1.0; the RSC GraphQL alternative is a future option.

## Settings

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `verify_tls` | boolean | `false` | Enforce a valid TLS certificate on the cluster endpoint |
| `request_timeout_seconds` | number | `15` | Per-request timeout for CDM API calls |

## Verify against a live cluster

This foundation was built from the official Rubrik API documentation. The
following should be confirmed against a live Rubrik CDM cluster before production
use, and are flagged inline in the source as "verify against a live Rubrik CDM":

- The service-account session request/response field names
  (`serviceAccountId` / `secret` → `token`) for the exact CDM version. **Local**
  CDM service accounts use `serviceAccountId` / `secret`; **RSC** service accounts
  use `clientId` / `clientSecret`.
- The v2 `sla_domain` create/patch body — this app models `frequencies` as an
  **object** keyed by tier (`hourly` / `daily` / `weekly` / `monthly`), each
  `{ frequency, retention }` with weekly `dayOfWeek` / monthly `dayOfMonth`.
- The exact **retention unit** for each tier (days vs weeks vs months).
- `GET /api/v1/cluster/me` as the connectivity/health probe.
- The v1 `fileset_template` create/patch body (`name`, `operatingSystemType`,
  `includes` / `excludes` / `exceptions`, `useWindowsVss`,
  `allowBackupNetworkMounts`, backup-script fields). Note: CDM **4.2+** may expect
  `operatingSystemType` **`UnixLike`** in place of `Linux` — this app offers
  `Linux` / `Windows`; verify the accepted enum on your cluster.
- The internal `managed_volume` create/patch body (`name`, `numChannels`,
  `volumeSize` in **bytes**, `subnet`, `applicationTag`, `exportConfig`) — and that
  `/api/internal/**` endpoints are internal and may change across CDM versions.
  `numChannels` / `volumeSize` are fixed at creation, so updates PATCH only the
  mutable subset.

### Sources

- Rubrik Developer Center — Cluster API authentication: https://developer.rubrik.com/Rubrik-Cluster-API/authentication/
- Rubrik CDM service accounts: https://docs.rubrik.com/en-us/9.2/ug/cdm/service_accounts.html
- Rubrik CDM APIs & service-account workflows: https://docs.rubrik.com/en-us/saas/saas/rubrik_apis_sa_workflows.html
- REST APIs overview: https://rubrikinc.github.io/rubrik-api-documentation/rest-apis/
- SLA APIs: https://rubrikinc.github.io/rubrik-api-documentation/use-cases/slas/
- Rubrik Postman collections (CDM v1/v2/internal REST — `fileset_template`, `managed_volume`): https://github.com/rubrikinc/rubrik-postman
- Rubrik PowerShell SDK (body field names — `New-RubrikFilesetTemplate`, `New-RubrikManagedVolume`): https://github.com/rubrikinc/rubrik-sdk-for-powershell
- Rubrik Developer Center — Filesets: https://developer.rubrik.com/Rubrik-Security-Cloud-API/Data-Protection/Data-Center/Filesets/
