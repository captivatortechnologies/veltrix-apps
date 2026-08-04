# Rubrik

Manage **Rubrik** (backup, ransomware recovery and data security) configuration
as code through the **Rubrik CDM** (Cloud Data Management) REST API.

- **Category:** COMPLIANCE
- **Version:** 0.3.0
- **Target component type:** `rubrik-cluster`

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **SLA Domains** | Backup policies — snapshot **frequencies** and **retention** per tier (hourly / daily / weekly / monthly), upserted by name | `GET`/`POST /api/v2/sla_domain`, `PATCH`/`DELETE /api/v2/sla_domain/{id}` |
| **Fileset Templates** | Reusable definitions of *what to back up* on a host — OS family plus **include / exclude / exception** paths (+ optional backup-script hooks), upserted by name | `GET`/`POST /api/v1/fileset_template`, `PATCH`/`DELETE /api/v1/fileset_template/{id}` |
| **Managed Volumes** | SLA-protected storage targets — **channels**, **size**, subnet, application tag and export host patterns, upserted by name (channels/size fixed at creation) | `GET`/`POST /api/internal/managed_volume`, `PATCH`/`DELETE /api/internal/managed_volume/{id}` |
| **Organizations** | Multi-tenancy containers that partition SLA domains, filesets and users — created by name (no verified rename) | `GET`/`POST /api/internal/organization`, `DELETE /api/internal/organization/{id}` |
| **Syslog Configuration** | The cluster's single syslog export target — hostname, protocol, port — for centralized log forwarding (a cluster singleton; a change is delete-then-create) | `GET`/`POST /api/internal/syslog`, `DELETE /api/internal/syslog/{id}` |
| **Global Cluster Settings** | Cluster name, timezone, geolocation, DNS nameservers/search domains, NTP servers and login banner (a cluster singleton) | `GET`/`PATCH /api/v1/cluster/me`, `GET`/`POST /api/internal/cluster/me/{dns_nameserver,dns_search_domain,ntp_server}`, `GET`/`PUT /api/internal/cluster/me/login_banner` |

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

## Coverage (v0.3.0)

Coverage was audited endpoint-by-endpoint against the two actively-maintained
Rubrik community SDKs — the **Rubrik PowerShell SDK**'s per-cmdlet API data
(`Rubrik/Private/Get-RubrikAPIData.ps1`, which maps every cmdlet to its exact
URI/method/body across CDM versions) and the **Rubrik Python SDK**'s
`rubrik_cdm/cluster.py` / `cloud.py` / `organization.py` source (which shows the
literal request bodies built for each call) — because Rubrik's REST API
reference is generated per-cluster (`https://<cluster>/docs/v1/api-docs`) and
is not published as a static, citable document. Every endpoint below is backed
by a real cmdlet or SDK method; nothing here is a guessed schema.

### Managed declarative configuration

| Configuration type | CDM REST operations | Source |
| --- | --- | --- |
| SLA Domains | `GET`/`POST /api/v2/sla_domain`, `PATCH`/`DELETE /api/v2/sla_domain/{id}` | Rubrik Postman v2 REST collection; PowerShell SDK `New`/`Set`/`Remove-RubrikSLA` |
| Fileset Templates | `GET`/`POST /api/v1/fileset_template`, `PATCH`/`DELETE /api/v1/fileset_template/{id}` | PowerShell SDK `New`/`Set`/`Remove-RubrikFilesetTemplate` |
| Managed Volumes | `GET`/`POST /api/internal/managed_volume`, `PATCH`/`DELETE /api/internal/managed_volume/{id}` | PowerShell SDK `New`/`Set`/`Remove-RubrikManagedVolume` |
| Organizations | `GET`/`POST /api/internal/organization`, `DELETE /api/internal/organization/{id}` | PowerShell SDK `Get`/`New`/`Remove-RubrikOrganization` — no rename endpoint exists in either SDK |
| Syslog Configuration | `GET`/`POST /api/internal/syslog`, `DELETE /api/internal/syslog/{id}` | Python SDK `cluster.configure_syslog()` — no `PATCH`; a change is delete-then-create |
| Global Cluster Settings | `GET`/`PATCH /api/v1/cluster/me`; `GET`/`POST /api/internal/cluster/me/{dns_nameserver,dns_search_domain,ntp_server}`; `GET`/`PUT /api/internal/cluster/me/login_banner` | Python SDK `cluster.configure_cluster_location()`, `configure_timezone()`, `configure_dns_servers()`, `configure_search_domain()`, `configure_ntp()`, `configure_login_banner()`; PowerShell SDK `Set-RubrikSetting` |

Organizations and Syslog Configuration have no mutable fields beyond
create/delete — an organization that already exists by name is left alone, and
syslog has no `PATCH` at all. Global Cluster Settings applies its five areas
independently: a matching area is never re-written, and each carries its own
prior-value rollback. All six types are cluster-scoped (`rubrik-cluster`); a
canvas assigned to more than one cluster applies the same declared values to
every one of them.

### Intentionally excluded

Every candidate below was researched against the same two SDKs before being
dropped — the drop is a finding, not a gap:

- **LDAP / Active Directory** (`/api/v1/ldap_service`) — both `New-RubrikLDAP`
  and `Set-RubrikLDAP` require `bindUserPassword` in the request body on
  **every** create *and* update; there is no separate credential object to
  reference instead. A directory bind password is secret material.
- **SMTP / notification settings** (`/api/internal/smtp_instance`) — creating
  the cluster's first SMTP config requires `smtpPassword` in the body
  (`cluster.configure_smtp_settings()`); later updates omit it, but this config
  type's declarative contract must support first-time creation, which cannot
  happen without embedding the secret.
- **Local users** (`/api/internal/user`) — `New-RubrikUser` and `Set-RubrikUser`
  both accept/require `password` in the body; provisioning cluster-admin-capable
  local accounts by automation is also a security-sensitive control-plane
  action, not steady-state configuration.
- **Roles** — there is no standalone "create a named custom role" REST
  resource in either SDK. The closest APIs
  (`/internal/authorization/role`, `/internal/authorization/role/organization`,
  `/internal/role/{id}/authorization`) grant **privileges directly to
  principals** (or attach authorization scopes to a built-in role template) —
  a security-sensitive RBAC grant, the same category this app already excludes
  users/credential administration from.
- **SNMP** (`/api/internal/cluster/me/snmp_configuration`) — only a `GET` is
  exposed by either SDK; no create/update body shape could be verified from a
  citable source, so this app does not guess one.
- **Replication targets** (`/api/internal/replication/target`) — pairing a
  target cluster requires that cluster's admin `username`/`password` in the
  body (`cluster.configure_replication_private()` /
  `configure_replication_nat()`) — the target cluster's own credentials, not
  this app's.
- **Archival locations** (`/api/internal/archive/{object_store,nfs,qstar}`) —
  re-evaluated for this release (the app previously dropped these for
  secrets-in-body without a from-source citation). Every verified **create**
  endpoint (`cloud.aws_s3_cloudout()`, `azure_cloudout()`,
  `add_aws_native_account()`) embeds a cloud credential (AWS access/secret key,
  Azure storage account/app key) directly in the body. NFS and Qstar archives
  have **no create endpoint at all** in either SDK — only `GET`. There is no
  non-secret create path to model, so this stays excluded.
- **Certificate management** — no CDM `v1`/`v2`/`internal` REST resource for
  certificates was found in either SDK. The only certificate-management API
  discoverable at all is Rubrik Security Cloud's GraphQL `globalCertificates`
  query (`developer.rubrik.com/Rubrik-Security-Cloud-API/System-Settings/Certificate-Management/`)
  — the RSC/Polaris SaaS control plane this app does not target (see the RSC
  note below).
- **Guest OS credentials** (`/api/internal/vmware/guest_credential`) —
  `add_guest_credential()` takes a `username`/`password` for the in-guest OS —
  pure secret material with no non-secret subset.
- **Blackout window** (`/api/internal/blackout_window`) — `Set-RubrikBlackout`
  is a single `isGlobalBlackoutActive` boolean **runtime** toggle (start/stop
  backups right now), not a scheduled desired-state policy — an imperative
  action, like the snapshot/backup-runtime actions this app already excludes.
- **Network throttle, notification settings, cluster VLANs** — network
  throttle (`/api/internal/network_throttle`) and notification settings
  (`/api/internal/notification_setting`) expose only a `GET` in either SDK
  (no verifiable write shape); cluster VLAN reassignment
  (`cluster.configure_vlan()`) can strand every node's network interface if
  misconfigured — a high-blast-radius bootstrap operation for a maintenance
  window, not a drift-corrected canvas.
- Per-object protection assignment (attaching an SLA Domain to a VM, database,
  fileset instance, etc.), snapshot/backup/restore/mount/export runtime
  actions, and read-only inventory/monitoring endpoints (events, reports,
  cluster/node hardware info) are out of scope for the same reasons already
  documented for the original three configuration types.

### Sources

- Rubrik PowerShell SDK — per-cmdlet API data (URI/method/body across CDM
  versions): https://github.com/rubrikinc/rubrik-sdk-for-powershell/blob/master/Rubrik/Private/Get-RubrikAPIData.ps1
- Rubrik Python SDK — cluster settings, syslog, DNS, NTP, login banner, SMTP,
  users, guest credentials: https://github.com/rubrikinc/rubrik-sdk-for-python/blob/master/rubrik_cdm/cluster.py
- Rubrik Python SDK — cloud/archival location creation (AWS S3, Azure):
  https://github.com/rubrikinc/rubrik-sdk-for-python/blob/master/rubrik_cdm/cloud.py
- Rubrik Python SDK — organization protectable-object authorization:
  https://github.com/rubrikinc/rubrik-sdk-for-python/blob/master/rubrik_cdm/organization.py
- Rubrik Developer Center — Cluster API authentication: https://developer.rubrik.com/Rubrik-Cluster-API/authentication/
- Rubrik Developer Center — System Settings / Certificate Management (RSC GraphQL, not this app's target): https://developer.rubrik.com/Rubrik-Security-Cloud-API/System-Settings/Certificate-Management/
- Rubrik CDM service accounts: https://docs.rubrik.com/en-us/9.2/ug/cdm/service_accounts.html
- REST APIs overview: https://rubrikinc.github.io/rubrik-api-documentation/rest-apis/
- SLA APIs: https://rubrikinc.github.io/rubrik-api-documentation/use-cases/slas/
- Rubrik Postman collections (CDM v1/v2/internal REST): https://github.com/rubrikinc/rubrik-postman
- Rubrik Developer Center — Filesets: https://developer.rubrik.com/Rubrik-Security-Cloud-API/Data-Protection/Data-Center/Filesets/

## Verify against a live cluster

This foundation was built from the official Rubrik API documentation and the
two community SDKs above. The following should be confirmed against a live
Rubrik CDM cluster before production use, and are flagged inline in the source
as "verify against a live Rubrik CDM" / "FLAG":

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
- Whether a later CDM version added a rename endpoint for organizations — none
  of the community SDKs consulted expose one.
- The syslog delete-then-create mechanism's fixed legacy id of `1`
  (`cluster.configure_syslog()`) — this app deletes using the real `id` the
  `GET` returns, falling back to `"1"` only if it is missing.
- Whether the target CDM version still wraps NTP servers as
  `{ data: [{ server }] }` (CDM 5.0+, per the Python SDK's version check)
  rather than a bare `string[]` (pre-5.0) — this app reads/writes the 5.0+
  shape and defensively accepts a bare array on `GET` too.
- The exact partial-update semantics of `PATCH /api/v1/cluster/me` — this app
  always sends the full declared `{ timezone, geolocation }` subset (plus
  `name` when set).
