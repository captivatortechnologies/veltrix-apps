# Microsoft Defender for Endpoint

Manage **Microsoft Defender for Endpoint (MDE)** threat intelligence as code on
the Veltrix Security-as-Code platform. Author configurations in the Configuration
Canvas and deploy them through the pipeline — validation, drift detection, health
checks and rollback are handled per configuration type.

MDE's own API is primarily a scanner/telemetry surface; its genuinely
configuration-as-code core is **indicators (IoCs)**. This app manages that core,
plus custom detection rules as a clearly-labeled preview.

## What it manages

| Configuration type | API | Notes |
| --- | --- | --- |
| **File Indicators** | `/api/indicators` | SHA-256 / SHA-1 / MD5 file hashes |
| **Network Indicators** | `/api/indicators` | IP (no CIDR) / domain / URL |
| **Certificate Indicators** | `/api/indicators` | SHA-1 certificate thumbprints |
| **Custom Detection Rules** *(preview)* | Graph beta `/security/rules/detectionRules` | Scheduled KQL detections — commercial cloud only |

Indicators are reconciled by their natural key `(indicatorType, indicatorValue)`;
`POST /api/indicators` is an upsert on that key. Deploys are **non-destructive** —
a deploy only touches the indicators it declares (create/update) and, on rollback,
deletes the ones it created and restores the ones it updated. It never deletes
indicators it did not declare (several config types and other tools may share the
tenant's 15,000-indicator pool).

## Connecting

1. **App registration** — in Microsoft Entra ID, create an app registration and
   add the **application** permission `Ti.ReadWrite.All` under *APIs my
   organization uses → WindowsDefenderATP* (with admin consent). For the preview
   detection rules, also add the Microsoft Graph application permission
   `CustomDetection.ReadWrite.All`.
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
- **Out of scope (by design):** device/RBAC groups, alert suppression rules, web
  content filtering, and ASR/AV/firewall policies are portal- or Intune/Graph
  `deviceManagement`-managed, not the MDE API — so they are not modeled here.
  Defender Vulnerability Management is read-only inventory, not declarative config.

## License

Apache-2.0
