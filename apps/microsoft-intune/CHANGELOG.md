# Changelog

All notable changes to the Microsoft Intune app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Intune policy (ASR rule policies and imported endpoint-security
  policies), each reported difference is now annotated with the person who made
  the last manual change and when, resolved from the **Intune audit events**
  (Microsoft Graph `deviceManagement/auditEvents`). The platform stores the
  `actor` on each diff and the drift view renders it, so a drift alert answers
  *who* and *when*, not just *what*.
  - Attribution queries the audit events per drifted policy, correlated to the
    object by its Graph resource id
    (`resources/any(r:r/resourceId eq '<id>')`), or by name
    (`resources/any(r:r/displayName eq '<name>')`) as a best-effort fallback for
    a deleted policy with no live id. Results are also correlated to the target
    client-side, and a broad time-window query is used as a fallback if a tenant
    rejects the resource filter — so an unrelated object's change is never
    mis-attributed.
  - It picks the most recent **human** actor (one carrying a
    `userPrincipalName`; application/service actors are excluded), preferring
    change-type events (Create / Patch / Update / Delete / …) and falling back to
    the most recent human event otherwise.
  - Veltrix's own deploys run app-only (OAuth2 client credentials) under the app
    registration identity, so they carry an application actor with no
    `userPrincipalName` and are dropped by the human-only filter; the connection
    Client ID (appId) is additionally excluded so the attribution reflects the
    *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an empty log, or no usable event, the diff is reported
    without an actor. Only policies that actually drifted are queried (one audit
    query per drifted policy). Reading audit events uses the app's existing
    `DeviceManagementConfiguration` Graph permission.

## 1.1.0

### Added
- Endpoint Security Policy (Import) config type — manage Defender endpoint
  security policies (Antivirus / Firewall / EDR / Disk encryption / Account
  protection) as code by importing an exported settings-catalog policy JSON.

## 1.0.0

### Added
- Initial release: manage Defender Attack Surface Reduction (ASR) rule policies
  as code via the Microsoft Graph beta settings catalog, with validation, drift
  detection and rollback through the Security-as-Code pipeline.
