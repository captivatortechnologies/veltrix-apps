# Microsoft Intune

Manage **Microsoft Intune** endpoint-security policies as code on the Veltrix
Security-as-Code platform, through the Microsoft Graph API. These policies
configure **Microsoft Defender for Endpoint** — and can be delivered via Intune
MDM enrollment *or* Defender security settings management — but they live on
Intune's `deviceManagement` API, so they get their own app (keeping the
`defender-endpoint` app on the GA, MDE-native APIs).

## What it manages

| Configuration type | Graph API | Notes |
| --- | --- | --- |
| **Attack Surface Reduction (ASR) Rules** | beta `/deviceManagement/configurationPolicies` (`endpointSecurityAttackSurfaceReduction`) | The finite, well-defined Defender ASR rule set (off / block / audit / warn) + folder/file exclusions |

ASR is the first configuration type because it is the one endpoint-security
family with a small, documented, hand-modelable rule set. Antivirus, EDR and
firewall policies (much larger, opaque settings-catalog schemas) are candidates
for a later "import & manage" model rather than an authored canvas.

## Connecting

1. **App registration** — in Microsoft Entra ID, create an app registration and
   add the Microsoft Graph **application** permission
   `DeviceManagementConfiguration.ReadWrite.All` (with admin consent). The tenant
   needs an **Intune license**.
2. **Credential** — store the **Client ID** in the credential `username` field
   and a **Client Secret** in the `API token` field.
3. **Component** — register an `intune-tenant` component and attach the
   credential.
4. **Settings** — set the **Tenant ID** (Entra directory GUID) and **Azure Cloud**
   app settings.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `tenant_id` | — (required) | Entra directory/tenant GUID for the token request |
| `azure_cloud` | `commercial` | commercial / gcc / gcc-high / dod — sets login + Graph host |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Notes & limitations

- **Beta API.** The settings-catalog / endpoint-security surface
  (`configurationPolicies`) is Microsoft Graph **beta** — there is no v1.0 GA, and
  Microsoft allows breaking changes. This is called out on the configuration type.
- **Intune license required.** Endpoint-security policies need an active Intune
  license in the tenant, unlike the MDE-native APIs.
- **National clouds.** ASR policies are available in commercial and US Gov clouds;
  US Gov High / DoD use the `graph.microsoft.us` Graph host (selected via the
  Azure Cloud setting).
- **Scope split.** This app is deliberately separate from `defender-endpoint`:
  Intune's `deviceManagement` API is a different (beta) surface with a different
  Graph permission and license requirement than the MDE-native indicators /
  detection-rules APIs.

## License

Apache-2.0
