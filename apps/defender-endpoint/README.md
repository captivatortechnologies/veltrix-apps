# Microsoft Defender for Endpoint

Manage **Microsoft Defender for Endpoint (MDE)** threat intelligence as code on
the Veltrix Security-as-Code platform. Author configurations in the Configuration
Canvas and deploy them through the pipeline — validation, drift detection, health
checks and rollback are handled per configuration type.

MDE's own API is primarily a scanner/telemetry surface. This app manages every
part of it that is genuinely declarative and API-writable: threat-intel
indicators (IoCs), custom detection rules (a clearly-labeled preview), device
tags and business criticality, the Live Response script library, and Defender
Vulnerability Management's authenticated network-scan definitions. See
**Coverage** below for the full, sourced accounting of what was checked and why
the rest (device/RBAC groups, web content filtering, alert notification/
suppression rules, advanced-features toggles, automation uploads/folder
exclusions, remediation-activity approval) is out of scope.

## What it manages

| Configuration type | API | Notes |
| --- | --- | --- |
| **File Indicators** | `/api/indicators` | SHA-256 / SHA-1 / MD5 file hashes |
| **Network Indicators** | `/api/indicators` | IP (no CIDR) / domain / URL |
| **Certificate Indicators** | `/api/indicators` | SHA-1 certificate thumbprints |
| **Custom Detection Rules** *(preview)* | Graph beta `/security/rules/detectionRules` | Scheduled KQL detections — commercial cloud only |
| **Machine Tags** | `/api/machines/{id}/tags` | Device tags, reconciled per (device, tag), non-destructive |
| **Device Values** | `/api/machines/{id}` | Business criticality (Normal/Low/High), single-valued per device |
| **Live Response Library** | `/api/libraryfiles` | Text scripts/tools for live response sessions, reconciled by file name |
| **Authenticated Scan Definitions** | `/api/DeviceAuthenticatedScanDefinitions` | Vulnerability Management SNMP network-device scans, reconciled by scan name |

Indicators are reconciled by their natural key `(indicatorType, indicatorValue)`;
`POST /api/indicators` is an upsert on that key. Deploys are **non-destructive** —
a deploy only touches the indicators it declares (create/update) and, on rollback,
deletes the ones it created and restores the ones it updated. It never deletes
indicators it did not declare (several config types and other tools may share the
tenant's 15,000-indicator pool).

## Connecting

1. **App registration** — in Microsoft Entra ID, create an app registration and
   add the WindowsDefenderATP **application** permissions your config types
   need (with admin consent), under *APIs my organization uses →
   WindowsDefenderATP*:
   - `Ti.ReadWrite.All` — file / network / certificate indicators.
   - `Machine.ReadWrite.All` — machine tags, device values, **and** scan
     definitions (one grant covers all three).
   - `Library.Manage` — the Live Response library.
   - Microsoft Graph `CustomDetection.ReadWrite.All` (commercial cloud only) —
     preview custom detection rules.
   Grant only what the config types you plan to use actually need.
2. **Credential** — store the app registration's **Client ID** in the credential
   `username` field and a **Client Secret** in the `API token` field.
3. **Component** — register an `mde-tenant` component whose hostname is your
   Defender API host (`api.security.microsoft.com`, a geo variant, or a gov host).
4. **Settings** — set the **Tenant ID** (Entra directory GUID) and **Azure Cloud**
   app settings.

The app exchanges the credential for a bearer token at
`https://<login-host>/<tenant>/oauth2/v2.0/token`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `tenant_id` | — (required) | Entra directory/tenant GUID for the token request |
| `azure_cloud` | `commercial` | commercial / gcc / gcc-high / dod — sets login host, token audience and default API host |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Notes & limitations

- **Token audience gotcha.** The bearer token must be minted for the *legacy*
  resource `https://api.securitycenter.microsoft.com/.default` even though requests
  go to `https://api.security.microsoft.com/api/...`; a token for the new host is
  rejected with 403. The client handles this automatically.
- **Indicator constraints.** IP indicators are single addresses (CIDR is not
  supported); `Audit` actions require *Generate alert*; body fields are
  case-sensitive; the valid action set is `Allowed` / `Audit` / `Block` /
  `BlockAndRemediate` (the legacy `Alert` / `AlertAndBlock` actions are rejected).
  A tenant allows up to **15,000 active indicators**.
- **`rbacGroupNames`** must reference **existing** device groups — this app cannot
  create device groups (there is no API; they are portal/Intune-managed).
- **Custom detection rules are PREVIEW.** They use the Microsoft Graph **beta**
  API, which Microsoft states is "not supported in production," are **commercial
  cloud only**, and need the separate `CustomDetection.ReadWrite.All` Graph
  permission (a second token audience). Use with that in mind.
- **Live Response library has no "download content" API.** A file this app
  creates rolls back cleanly; a file it overwrites (one that already existed)
  cannot have its exact prior bytes restored on rollback — there is no
  endpoint to read them back from. See the Coverage section and
  `config-types/mde-live-response-library/rollback.ts`.
- **Scan-definition SNMP credentials are write-only end to end.** Never read
  back, diffed, or stored in rollback state — Microsoft's own docs are
  inconsistent about whether `GET` ever echoes the credential back at all.
  Rolling back an *updated* scan definition restores every structural field but
  cannot undo a credential change the forward deploy made. See
  `config-types/mde-scan-definitions/rollback.ts`.
- **Out of scope (by design):** device/RBAC groups, alert suppression rules, web
  content filtering, alert notification (email) rules, advanced-features
  toggles, and automation uploads/folder exclusions are portal-only (verified —
  no public API exists for any of them). ASR/AV/firewall policies are
  Intune/Graph `deviceManagement`-managed, not the MDE API. Remediation
  activities (automated-investigation approvals) are read-only via the public
  API. See **Coverage** below for the full, sourced breakdown.

## Coverage (v1.4.0)

Coverage was audited against the current
[Supported Microsoft Defender for Endpoint APIs](https://learn.microsoft.com/en-us/defender-endpoint/api/exposed-apis-list)
index (125 documented API pages, reviewed 2026-08-04) plus the linked
conceptual docs for every candidate that isn't a plain REST endpoint. The goal:
every genuinely declarative, API-writable piece of MDE/Defender Vulnerability
Management configuration is modeled here; everything else is named below with
the specific evidence for why it isn't.

### Managed declarative configuration

| Configuration type | API | Write operations |
| --- | --- | --- |
| File / Network / Certificate indicators | `/api/indicators` (`ti-indicator`) | `POST` (upsert) / `DELETE` / `Batch Delete` |
| Custom detection rules *(preview)* | Graph beta `/security/rules/detectionRules` | `POST` / `PATCH` / `DELETE` |
| Machine tags | `/api/machines/{id}/tags` | `POST` (Add/Remove) |
| Device values | `/api/machines/{id}` (`Update machine`) | `PATCH` |
| Live Response library | `/api/libraryfiles` | `POST` (multipart upload) / `DELETE` |
| Authenticated scan definitions | `/api/DeviceAuthenticatedScanDefinitions` | `POST` / `PATCH` / `POST .../BatchDelete` |

`Update machine` (the API behind machine tags and device values) accepts
exactly two writable properties — `machineTags` and `deviceValue` — confirmed
against its current property table, so those two config types already exhaust
that endpoint. The indicator resource's `indicatorType` enum (`FileSha1` /
`FileSha256` / `FileMd5` / `CertificateThumbprint` / `IpAddress` / `DomainName`
/ `Url`) is unchanged from what the three indicator config types already cover
— no new indicator subtype exists to add.

### Verified out of scope — portal-only (no public API)

Each of these was fetched from its current Microsoft Learn page and confirmed
to describe **only** portal steps, with no REST or Graph API mentioned:

| Feature | Portal path | Source |
| --- | --- | --- |
| Web content filtering policies | Settings → Endpoints → Rules → Web content filtering | [web-content-filtering](https://learn.microsoft.com/en-us/defender-endpoint/web-content-filtering) |
| Device / RBAC groups | Settings → Endpoints → Permissions → Device groups | [machine-groups](https://learn.microsoft.com/en-us/defender-endpoint/machine-groups) |
| Alert (email) notification rules | Settings → Endpoints → General → Email notifications | [configure-email-notifications](https://learn.microsoft.com/en-us/defender-xdr/configure-email-notifications) |
| Advanced features (all toggles) | Settings → Endpoints → Advanced features | [advanced-features](https://learn.microsoft.com/en-us/defender-endpoint/advanced-features) |
| Automation file uploads (content analysis) | Settings → Endpoints → Rules → Automation uploads | [manage-automation-file-uploads](https://learn.microsoft.com/en-us/defender-endpoint/manage-automation-file-uploads) |
| Automation folder exclusions | Settings → Endpoints → Automation folder exclusions | [automation-folder-exclusions-configure](https://learn.microsoft.com/en-us/defender-endpoint/automation-folder-exclusions-configure) |
| Alert suppression rules | Settings → Endpoints → Rules → Alert suppression | [manage-suppression-rules](https://learn.microsoft.com/en-us/defender-endpoint/manage-suppression-rules) |

Device groups deserve a specific callout: `rbacGroupNames` / `rbacGroupIds` on
indicators, and `scannerAgent` on scan definitions, both **reference** existing
device groups by name/id — this app can point at a group, it just cannot
create, rename, or delete one, because Microsoft doesn't expose that as an API.

### Verified out of scope — read-only or imperative, not desired state

- **Remediation activities** (`get-remediation-methods-properties` /
  `get-remediation-one-activity` / `get-remediation-all-activities` /
  `get-remediation-exposed-devices-activities`) are **GET-only** in the current
  API index — approving or rejecting a pending automated-investigation action
  has no public write endpoint.
- **Alerts** (`batch-update-alerts`, `update-alert`) are per-alert triage
  (status, classification, assignee, comment) — a point-in-time judgment call
  on an existing incident, not a piece of declarative desired state.
- **Machine actions** (isolate / unisolate / restrict / unrestrict app
  execution / run AV scan / run live response / offboard / stop-and-quarantine
  / cancel) and **Start Investigation** are one-shot imperative response
  actions on a device, not configuration.
- **Advanced Hunting** (`run-advanced-query-api`) executes a KQL query and
  returns results — it has nothing to persist as state.
- Domains / Files / IPs / Users / Software / Vulnerabilities / Recommendations
  / Score / Investigations are read-only reporting and inventory surfaces.

### Scoped narrower than the underlying API, by design

- **Live Response library** models **text** scripts only. The Upload API also
  accepts arbitrary binaries (Microsoft's own example uploads a `.exe` memory
  dump tool), but a text canvas field can't practically author binary bytes —
  binary tool uploads remain a portal (or direct API) operation outside this
  UI.
- **Authenticated scan definitions** model exactly the one documented
  `scanType` (`Network`) and one documented authentication shape
  (`SnmpAuthParams`) — this app does not invent fields for a broader surface
  Microsoft hasn't published.

## License

Apache-2.0
