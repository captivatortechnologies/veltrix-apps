# Changelog

All notable changes to the Microsoft Sentinel app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-08-05

### Added
- **Fusion rule** (new configuration type `sentinel-fusion-rule`, grouped under
  Analytics Rules). Manages Microsoft Sentinel's built-in Fusion (Advanced
  Multi-Stage Attack Detection) correlation rule via
  `Microsoft.SecurityInsights/alertRules` (kind `Fusion`) at the GA api-version
  2024-09-01 — verified against learn.microsoft.com "Alert Rules - Create Or
  Update", which documents Fusion as a stable request-body kind alongside
  Scheduled and MicrosoftSecurityIncidentCreation. Fusion is a per-workspace
  **singleton** that already exists on every onboarded workspace (enabled by
  default) under a system-assigned `ruleId`; the only writable properties are
  the fixed `alertRuleTemplateName` and `enabled`. Because there is no
  customer-chosen name to slug into a ruleId, deploy reconciles by **kind**
  (lists the workspace's alertRules and matches the item with `kind ===
  "Fusion"`) rather than by name, then updates that exact resource — matching
  the pattern already used for indicator reconciliation
  (`sentinel-threat-indicators`). Full validate / deploy / rollback / health /
  drift / status handlers; a canvas may declare it at most once.

### Documentation
- Added a README **Coverage** section: every managed configuration type grouped
  by sidebar group, plus every genuinely-assessed exclusion with a sourced
  reason (Content Hub / solution installs, granular watchlist-item CRUD,
  CCP/codeless data connectors, incidents/entities/bookmarks, and more).
- Corrected the README's stale "Deliberately out of scope" section, which
  pre-dated the 1.2.0/1.3.0 additions and incorrectly still listed hunting
  queries, data connectors and threat-intelligence indicator upload as
  unsupported — all three have been implemented (and GA, not preview, for
  indicators) since 1.2.0/1.3.0.

## 1.3.0 — 2026-07-28

### Added
- **Six new configuration types**, grouped in the sidebar:
  - **Analytics Rules** — Microsoft Security rules (kind MicrosoftSecurityIncidentCreation)
    and Anomaly (ML) rules (securityMLAnalyticsSettings).
  - **Threat Intelligence** — hand-authored threat intelligence indicators.
  - **Settings** — product settings (UEBA / Entity Analytics / Anomalies / EyesOn).
  - **Content** — workbooks (Microsoft.Insights, scoped to the workspace) and
    source-control repository connections (content-as-code; write-only creds).
- Existing 5 types assigned to sidebar groups (Analytics Rules / Automation /
  Content / Hunting / Data Collection).

## 1.2.0 — 2026-07-26

### Added
- **Hunting queries & saved searches** (new configuration type
  `sentinel-hunting-queries`). Manages Log Analytics saved searches via
  `Microsoft.OperationalInsights/workspaces/savedSearches` (api-version
  2023-09-01, GA) — Sentinel hunting queries are saved searches with category
  "Hunting Queries", and an optional function alias/parameters exposes a query as
  a reusable KQL function. Reconciled by name (slugged into the `savedSearchId`);
  updates PUT with etag `"*"` to override. Full validate / deploy / rollback /
  health / drift / status handlers.
- **Data connectors** (new configuration type `sentinel-data-connectors`).
  Enables the Microsoft first-party, tenant-based connectors that the
  `Microsoft.SecurityInsights/dataConnectors` API can create/update (api-version
  2024-09-01, GA): Microsoft Entra ID Protection, Defender for Identity, Defender
  for Endpoint, Defender for Cloud Apps and Microsoft 365 — each written as a
  `{ tenantId, dataTypes: { …: { state } } }` body. Reconciled by the ARM
  `dataConnectorId`. CCP/codeless, AWS, threat-intel and portal-only connectors
  are intentionally out of scope.
- **NRT (near-real-time) analytics rules** on the existing
  `sentinel-analytics-rules` type. A rule now carries a **kind** (Scheduled or
  NRT); NRT rules omit query frequency/period and the trigger operator/threshold
  (they run continuously). Because `kind:NRT` is **not** part of the stable
  alertRules contract, NRT rules are read/written against a preview api-version
  (2024-01-01-preview) while Scheduled rules stay on GA (2024-09-01); rollback
  and drift are kind-aware.
- **Run-playbook automation-rule action** on the existing
  `sentinel-automation-rules` type. An automation rule can now bind a Logic App
  playbook (`RunPlaybook` action with `logicAppResourceId` and an optional
  cross-tenant `tenantId`) in addition to, or instead of, the modify-properties
  action. Validation checks the playbook ARM id shape; drift compares the bound
  playbook.

### Notes
- The Sentinel service principal needs, in addition to "Microsoft Sentinel
  Contributor": permission to write Log Analytics saved searches for hunting
  queries, and the "Microsoft Sentinel Automation Contributor" role on a
  playbook's resource group for run-playbook actions.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Sentinel resource (scheduled analytics rules, automation rules, and
  watchlists), each reported difference is now annotated with the person who made
  the last manual change and when, resolved from the **Azure Activity Log**
  (`Microsoft.Insights/eventtypes/management/values`, api-version 2015-04-01).
  The platform stores the `actor` on each diff and the drift view renders it, so
  a drift alert answers *who* and *when*, not just *what*.
  - Sentinel objects are Azure Resource Manager resources, so the audit trail is
    the subscription's Activity Log rather than Microsoft Graph. Attribution
    queries the management events per drifted resource, filtered to the object by
    its ARM resource id (`resourceUri eq '<resourceId>'`) over a ~7-day window,
    and the returned records are ALSO correlated to the target client-side — so
    an unrelated resource's change is never mis-attributed.
  - It picks the most recent **human** actor (a `caller` that looks like a
    UPN/email; bare appId/GUID service principals are excluded), preferring
    change-type operations (write / delete / action) and falling back to the most
    recent human event otherwise.
  - Veltrix's own deploys authenticate as the Entra app registration (OAuth2
    client credentials), so they appear under the app's appId (a GUID) and are
    dropped by the human-only filter; the connection Client ID (appId) is
    additionally excluded so the attribution reflects the *manual* change rather
    than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an empty log, or no usable event, the diff is reported
    without an actor and the UI shows "—". Only resources that actually drifted
    are queried (one Activity Log query per drifted resource). Reading the
    Activity Log requires `Microsoft.Insights/eventtypes/values/read` at the
    subscription; a service principal scoped only to the workspace resource group
    may be denied, which simply degrades to "—".

## 1.0.0

### Added
- Initial release: manage Microsoft Sentinel detection and response content as
  code via the Azure Resource Manager (ARM) API — scheduled (KQL) analytics
  rules, automation rules, and watchlists — each with validation, drift detection
  and rollback through the Security-as-Code pipeline.
