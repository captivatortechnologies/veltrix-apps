# Microsoft Intune

Manage **Microsoft Intune** device-management and endpoint-security policy as
code on the Veltrix Security-as-Code platform, through the Microsoft Graph
`deviceManagement` / `deviceAppManagement` APIs.

## What it manages

| Group | Configuration type | Graph resource | API |
| --- | --- | --- | --- |
| Endpoint Security | Attack Surface Reduction (ASR) Rules | `endpointSecurityAttackSurfaceReduction` settings-catalog policy | beta `configurationPolicies` |
| Endpoint Security | Endpoint Security Policy (Import) | Any settings-catalog policy (AV / Firewall / EDR / Disk encryption / Account protection), imported by JSON | beta `configurationPolicies` |
| Compliance | Device Compliance Policies | Per-platform compliance policy + non-compliance scheduled actions | v1.0 `deviceCompliancePolicies` |
| Windows Updates | Windows Update Rings | Deferral / deadline / active hours / delivery optimization | v1.0 `deviceConfigurations` (`windowsUpdateForBusinessConfiguration`) |
| Windows Updates | Windows Feature Update Profiles | Target feature version + gradual rollout window | `windowsFeatureUpdateProfile` |
| Windows Updates | Windows Quality Update Profiles | Expedite a released quality update + forced-reboot grace | `windowsQualityUpdateProfile` |
| Windows Updates | Driver Update Profiles | Manual/automatic driver-update approval + deferral window | beta `windowsDriverUpdateProfile` |
| Assignments | Assignment Filters | Device/app targeting rule DSL used by every other policy's assignment | v1.0 `deviceAndAppManagementAssignmentFilter` |
| App Protection | iOS App Protection Policies | PIN, data-transfer/clipboard, Save As, device-compliance gate (MAM) | `iosManagedAppProtection` |
| App Protection | Android App Protection Policies | PIN, data-transfer/clipboard, Save As, device-compliance gate (MAM) | `androidManagedAppProtection` |
| App Protection | App Configuration Policies | Custom key/value settings pushed into managed apps (MAM) | `targetedManagedAppConfiguration` |
| Scripts & Remediations | Device Remediations | Detection + remediation PowerShell script pair, on a schedule | `deviceHealthScript` |
| Scripts & Remediations | Platform Scripts | Windows PowerShell management scripts run on managed devices | `deviceManagementScript` |
| Governance | Role Scope Tags | RBAC scoping labels referenced by policies and role assignments | `roleScopeTag` |

Every type reconciles by name against the live tenant (create/update by
`displayName`), converges assignments via each resource's `assign` action when
the canvas declares a target, and is non-destructive — objects not declared on
the canvas are left untouched.

## Coverage

This section is the record of a research-first exhaustiveness pass against the
Microsoft Graph `deviceManagement` + `deviceAppManagement` reference (learn.
microsoft.com/graph/api/resources/intune-graph-overview, v1.0 and beta) run
2026-08-05: what is managed, grouped by area, and — for everything genuinely
declarative that is **not** managed — the sourced reason it stays out of scope.

### Managed, by group

- **Endpoint Security** — ASR rules (the finite, well-defined Defender
  hardening rule set, hand-modeled) plus a generic settings-catalog **import**
  model for everything else (Antivirus / Firewall / EDR / Disk encryption /
  Account protection). The legacy typed `deviceManagement/intents` endpoint
  Microsoft is retiring in favor of the settings catalog is intentionally not
  modeled — `configurationPolicies` is the modern, maintained surface.
- **Compliance** — per-platform compliance policies with their required
  non-compliance scheduled actions and assignments.
- **Windows Updates** — all four of Intune's Windows update-management
  surfaces: rings, feature update profiles, quality (expedite) update profiles,
  and driver update profiles. Approving or declining specific driver updates
  found in a profile's live device inventory (the `executeAction` /
  `syncInventory` actions) is device-state, not declarative config, and stays
  out of scope — this manages only the profile's policy shell (approval mode +
  deferral + assignments).
- **Assignments** — assignment filters, the device/app targeting DSL every
  other structured policy type in this app can reference.
- **App Protection (MAM)** — iOS/Android app protection policies (PIN,
  data-transfer/clipboard, Save As, a device-compliance + minimum-OS gate) and
  app configuration policies (custom key/value settings), each with targeted
  apps and assignments. The app protection policies model a **curated core**
  of settings, not the full `conditionalLaunch` rule array — jailbreak/root
  detection block, a PIN-retry wipe action, an offline-grace-period wipe, and a
  maximum allowed device threat level are not modeled. This mirrors the app's
  existing "hand-model the well-defined core, don't chase every nested rule"
  approach (the same reasoning documented below for ASR vs. the full
  settings-catalog).
- **Scripts & Remediations** — device remediations (detect + remediate script
  pairs) and platform scripts (PowerShell run on managed devices), both with
  assignments.
- **Governance** — role scope tags (the RBAC labels). Assigning a scope tag to
  admins (the actual `roleAssignment`) is a separate resource — see below.

### Considered and excluded this pass (sourced)

- **Intune custom RBAC** (`deviceManagement/roleDefinitions` +
  `roleAssignments`, v1.0). A `roleDefinition`'s `rolePermissions` is a list of
  `resourceActions` — `allowedResourceActions` / `notAllowedResourceActions` —
  drawn from a large (100+), versioned catalog of permission strings (one per
  Intune resource category × operation) that Microsoft does not publish as a
  fixed enum in the Graph reference. Hand-modeling this canvas risks silently
  omitting a valid action or accepting an invalid one — the same "opaque,
  heavier schema" reasoning that already routed AV/EDR/Firewall to the generic
  settings-catalog **import** model instead of a typed canvas. Built-in roles
  cannot be modified regardless (`isBuiltIn: true` roles are read-only per
  Microsoft Learn), so only custom-role authoring would be in scope even if
  built.
- **Device-targeted app configuration**
  (`deviceAppManagement/mobileAppConfigurations`,
  `managedDeviceMobileAppConfiguration`, v1.0). Distinct from the
  MAM-targeted `targetedManagedAppConfiguration` this app already manages —
  this variant configures apps on **enrolled (MDM-managed)** devices instead of
  unmanaged/BYOD apps. Its payload is per-platform and opaque: iOS
  (`iosMobileAppConfiguration`) carries a base64-encoded XML plist; Android
  (`androidManagedStoreAppConfiguration`) carries a JSON payload whose schema is
  fetched per-app from the Play Store managed-configuration API at authoring
  time. Neither is a stable, hand-modelable canvas without a live schema-fetch
  dependency.
- **Notification message templates** (`deviceManagement/notificationMessageTemplates`,
  v1.0). The resource itself is simple (`displayName`, `description`,
  `defaultLocale`, `brandingOptions`, localized subject/body messages) and
  would be a low-risk addition on its own — but it is only useful wired into a
  compliance policy's non-compliance action (`notificationTemplateId`, which
  `intune-compliance-policies` today always sends as an empty string, i.e. no
  custom template referenced). Making that reference useful means extending an
  already-shipped, tested config type to resolve a template name to id — real,
  valuable follow-up scope, but more than a same-pass addition.
- **Terms and Conditions** (`deviceManagement/termsAndConditions`). Microsoft
  has retired this Intune feature in favor of Microsoft Entra ID Terms of Use;
  the previously-documented Graph resource page under
  `graph/api/resources/intune-*-termsandconditions` no longer resolves on
  Microsoft Learn, consistent with removal.
- **Enrollment restrictions/configurations**
  (`deviceEnrollmentConfigurations`) and **Autopilot deployment profiles**
  (`windowsAutopilotDeploymentProfiles`) — deferred since v1.5.0 as
  provisioning-time surfaces distinct from post-enrollment policy management.
- **Legacy per-platform device configuration profiles** (Wi-Fi / VPN / Email /
  certificate `deviceConfigurations` subtypes) and **ADMX administrative
  templates** (`groupPolicyConfigurations`) — deferred since v1.5.0; the
  actively-maintained settings-catalog surface is already covered by the
  generic import model (`intune-security-policy`), and the legacy typed
  subtypes are a long tail of narrow, single-purpose schemas.
- **Conditional Access policies** live on Microsoft Entra ID's
  `identityAndAccess` surface, not Intune's `deviceManagement` API — out of
  scope for this app (see the `microsoft-entra` app).

### Always excluded (not config-as-code)

- **Device actions** — wipe / retire / sync / remote lock and similar
  imperative device-state operations. These are one-shot actions on a specific
  device, not a declarative policy to converge to.
- **App package binaries / content** — mobile app (LOB/store) packages and
  their content versions are binary artifacts, not policy.
- **Read-only reports** — device/config/compliance reports and Endpoint
  analytics are telemetry, not configuration.
- **Secret material** — anything requiring a live SCEP/PKCS/Exchange connector
  round-trip (certificate profiles, Exchange connectors) is out of scope; this
  app never handles or stores that class of secret.

## Connecting

1. **App registration** — in Microsoft Entra ID, create an app registration and
   add the Microsoft Graph **application** permission
   `DeviceManagementConfiguration.ReadWrite.All` (with admin consent). The
   tenant needs an **Intune license**.
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

- **Beta API surface.** ASR rules, the imported Endpoint Security Policy type,
  and Driver Update Profiles are Microsoft Graph **beta** — there is no v1.0
  general availability for these, and Microsoft allows breaking changes. This
  is called out on each affected configuration type. Every other type in this
  app is Graph v1.0.
- **Intune license required.** All of these APIs need an active Intune license
  in the tenant.
- **National clouds.** US Gov High / DoD use the `graph.microsoft.us` Graph
  host (selected via the Azure Cloud setting); GCC (moderate) uses the
  commercial Graph host.
- **Scope split.** This app is deliberately separate from `defender-endpoint`:
  Intune's `deviceManagement` API is a different surface, with a different
  Graph permission and license requirement, than the MDE-native indicators /
  detection-rules APIs.
- **Windows Update API interaction.** Microsoft Graph has two independent APIs
  that can manage Windows Update settings — the Intune APIs this app uses, and
  a separate Windows Updates API. They are not compatible: each can silently
  overwrite configuration made by the other. Do not manage the same tenant's
  Windows Update settings through both.

## License

Apache-2.0
