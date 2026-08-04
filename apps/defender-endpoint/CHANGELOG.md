# Changelog

All notable changes to the Microsoft Defender for Endpoint app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-08-04

Exhaustive pass over the Microsoft Defender for Endpoint config-as-code write
surface (research-first, against the current "Supported Microsoft Defender for
Endpoint APIs" index). Two genuinely-declarative, previously-uncovered
resources were found and added; the surface the app already excluded
(device/RBAC groups, web content filtering, alert notification/suppression
rules, advanced-features toggles, automation uploads/folder exclusions,
remediation-activity approval) was independently re-verified and remains
correctly out of scope — see the README **Coverage** section for the full,
sourced breakdown.

### Added
- **Live Response library config type (`mde-live-response-library`).** Manage
  the tenant-wide Live Response library — the scripts/tools analysts can run in
  a live response session — as code, via `POST` / `DELETE /api/libraryfiles`.
  Each item declares a file name, description, whether it accepts parameters,
  and its (text) content; reconciliation is an upsert by (case-insensitive)
  file name (`OverrideIfExists=true`), and scope is deliberately limited to
  TEXT scripts (PowerShell / bash / Python / etc.) — the API also accepts
  arbitrary binaries, but authoring binary bytes in a text canvas field isn't
  practical, so binary tool uploads stay a portal-only operation.
  - Needs the **`Library.Manage`** application permission — separate from
    `Ti.ReadWrite.All` / `Machine.ReadWrite.All` used by the other config
    types.
  - The API has **no "download content" endpoint** — `GET /api/libraryfiles`
    returns metadata only (name, sha256, description, timestamps), never the
    bytes. Drift detection works around this by comparing the SHA-256 of the
    *declared* content (computed locally) against Defender's own `sha256`,
    without ever reading back or logging live content. Rollback cannot fully
    work around it: a file this app **creates** rolls back cleanly (delete),
    but a file it **overwrites** (one that already existed — from an earlier
    deploy of the same item, the portal, or another tool) can never have its
    exact prior bytes restored, because there is nothing to read them back
    from. This is called out by name in the rollback result message rather
    than silently reported as a full success — a documented, honest API
    limitation, not a gap in the handler.
  - Required `lib/mde.ts` to grow multipart/form-data support (a new
    `postMultipart` client method sharing the existing token/retry transport)
    — the API's Upload endpoint is the first one in this app that isn't plain
    JSON.
- **Authenticated scan definitions config type (`mde-scan-definitions`).**
  Manage Defender Vulnerability Management's authenticated **network-device
  (SNMP) scan** definitions as code, via `POST` (create) / `PATCH` (update) /
  `POST .../BatchDelete` (delete) against
  `/api/DeviceAuthenticatedScanDefinitions`. Each item declares a scan name,
  active state, run interval, one or more IP/hostname targets, the onboarded
  device acting as the scanner agent, and the SNMP credential (community
  string, or a username + auth/privacy protocol and password, or an Azure Key
  Vault reference in place of an inline secret). The API assigns its own `id`
  on create, so — like Cisco Meraki's group-policies type — this reconciles by
  a human-chosen natural key, `scanName` (case-insensitive).
  - Needs the **`Machine.ReadWrite.All`** application permission — the SAME
    permission already required by machine tags / device values, so no new
    Entra consent is needed if those config types are already in use.
  - `scanAuthenticationParams` (the SNMP credential) is treated as **write-only
    end to end**: never read back, diffed, or persisted in rollback state.
    Beyond the general "never trust a live credential value" stance, Microsoft's
    own documentation is internally inconsistent about whether `GET` ever even
    echoes it back (the add/update example responses show it `null`; the list
    example shows it populated) — given that inconsistency, this app doesn't
    rely on it either way. It is rebuilt from the canvas and re-sent on every
    deploy (create and update alike).
    Rollback of an **updated** definition restores every non-secret field
    (name / active / targets / target type / interval / scanner device) via a
    `PATCH` that **omits** `scanAuthenticationParams` — which, per Microsoft's
    docs, leaves the live credential untouched rather than clearing it. That
    means a rollback fully undoes a structural-only change, but **cannot**
    undo a credential change the forward deploy made (there is nothing to
    restore it from) — documented plainly in the rollback result message and
    in code, not silently swallowed.
  - Currently only `scanType: "Network"` and one authentication shape
    (`SnmpAuthParams`) are documented by Microsoft; this type models exactly
    that surface rather than a hypothetical broader one.

## 1.3.1 — 2026-08-02

Grouped the six configuration types in the Configurations sidebar.

- **Config sidebar groups** — Custom Indicators (file / network / cert),
  Detection Rules, and Device Management (machine tags / device values).
  Organization-only — no change to any deploy/rollback/drift behavior.

## 1.3.0 — 2026-07-28

### Added
- **Device value config type (`mde-device-values`).** Manage a device's
  **business criticality** — `Normal` / `Low` / `High` — as code. This is the
  `deviceValue` property that weights a device in Defender Vulnerability
  Management exposure scoring. Each item declares one device (by its stable
  40-hex Defender device id, or by computer name) and the criticality it should
  carry; the value is reconciled per device via `PATCH /api/machines/{id}`.
  - Unlike tags (a non-destructive set), `deviceValue` is a **single-valued**
    property, so deploy captures the previous value per device and rollback
    restores it exactly. Only one item may own a given device's value; the
    validator rejects a device declared twice.
  - A device referenced by **computer name** is resolved with an OData `$filter`
    on `computerDnsName` and may match more than one device; the value applies to
    every match. A device referenced by **id** is a single `GET /api/machines/{id}`.
  - A referenced device that no longer resolves (never onboarded, or aged out of
    the retention window) is recorded and skipped rather than failing the deploy;
    drift reports it as **critical** and a changed live value as a **warning**.
  - Shares the `Machine.ReadWrite.All` application permission already used by the
    machine-tags type (same Update-machine endpoint).

## 1.2.0 — 2026-07-26

### Added
- **Machine tags config type (`mde-machine-tags`).** Manage Defender device
  (machine) tags as code. Each item declares one device — by its stable 40-hex
  Defender device id, or by computer name — and the set of tags that should be
  present on it. Tags are reconciled per (device, tag) via
  `POST /api/machines/{id}/tags` with `Action: Add`, and the reconciliation is
  **idempotent and non-destructive**: only tags this app added are removed on
  rollback, and tags set by the portal or other tools are never touched.
  - A device referenced by **computer name** is resolved with an OData `$filter`
    on `computerDnsName` and may match more than one device (e.g. after a
    re-image); the tags apply to every match. A device referenced by **id** is
    resolved with a single `GET /api/machines/{id}`.
  - A referenced device that is not found (never onboarded, or aged out of the
    retention window) is recorded and skipped rather than failing the deploy;
    drift and health checks flag it.
  - Drift reports a declared device that no longer resolves as **critical** and a
    missing declared tag as a **warning**. Unlike indicators and detection rules,
    the Machine resource carries **no** per-tag audit stamps and Defender exposes
    no config-change audit log for tags, so tag drift is not attributed to an
    actor.
  - Requires the `Machine.ReadWrite.All` application permission (distinct from the
    `Ti.ReadWrite.All` used by the indicator types).

### Not covered (no public API)
- **Device / machine groups** are portal-only (Settings > Endpoints >
  Permissions > Device groups); Defender exposes no public REST API to create,
  update, or delete them (the Machine resource surfaces `rbacGroupId` /
  `rbacGroupName` read-only). **Web content filtering policies** are likewise
  portal-only (Settings > Endpoints > Rules > Web content filtering) with no
  public Defender or Microsoft Graph API. Neither is stubbed.

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
