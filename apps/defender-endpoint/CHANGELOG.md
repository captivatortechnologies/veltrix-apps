# Changelog

All notable changes to the Microsoft Defender for Endpoint app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Defender object (file / network / certificate indicators and custom
  detection rules), each reported difference is now annotated with the person who
  made the last manual change and when. The platform stores the `actor` on each
  diff and the drift view renders it, so a drift alert answers *who* and *when*,
  not just *what*.
  - Defender exposes **no** config-change audit-log endpoint for these object
    types (the Intune `deviceManagement/auditEvents` and Entra
    `auditLogs/directoryAudits` sources do not cover indicators or Defender
    custom detection rules). Attribution is instead read from each object's own
    first-party stamps, already returned by the drift check — so it adds **no**
    extra API call:
    - Indicators: `createdBy` / `createdBySource` / `sourceType` /
      `creationTimeDateTimeUtc` and `lastUpdatedBy` / `lastUpdateTime`.
    - Detection rules: `createdBy` / `createdDateTime` and `lastModifiedBy` /
      `lastModifiedDateTime`.
  - It picks the most recent **human** actor, preferring the change (update)
    stamp and falling back to the create stamp. For indicators, `sourceType`
    (`User` vs `AadApp`) reliably distinguishes a human from an application; for
    detection rules (which carry no such flag) a user-principal-name ("@")
    heuristic is used as best effort.
  - Veltrix's own deploys run app-only (OAuth2 client credentials), so the
    objects they write are stamped with the app registration identity —
    indicators as `sourceType: AadApp` (dropped by the human-only filter) and
    rules as a non-UPN app name (dropped by the same filter). The connection
    Client ID (appId) is additionally excluded, so attribution reflects the
    *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error or no usable stamp, the diff is reported without an
    actor. A **deleted** object is unattributable: its stamps are gone with it
    and there is no audit log to name the deleter.

## 1.0.0

### Added
- Initial release: manage Microsoft Defender for Endpoint threat intelligence as
  code — file, network and certificate indicators (IoCs) via the Defender
  `/api/indicators` API, plus custom detection rules (preview) via the Microsoft
  Graph beta API — with validation, drift detection and rollback through the
  Security-as-Code pipeline.
