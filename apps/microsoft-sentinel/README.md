# Microsoft Sentinel

Manage Microsoft Sentinel detection and response content **as code** through the
Azure Resource Manager (ARM) API. Authoring happens in the Veltrix Configuration
Canvas; every write goes through the Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback).

Microsoft Sentinel is managed through **Azure Resource Manager**
(`https://management.azure.com`), **not** Microsoft Graph. Most resources live
under:

```
/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/
  workspaces/{ws}/providers/Microsoft.SecurityInsights/...
```

Hunting queries / saved searches are the one exception — they are Log Analytics
`savedSearches` under `Microsoft.OperationalInsights` directly, not
`Microsoft.SecurityInsights` (see the table below).

## Configuration types

| Config type | Sidebar group | ARM resource | api-version | Reconcile key |
| --- | --- | --- | --- | --- |
| **Analytics Rules (Scheduled / NRT)** | Analytics Rules | `alertRules` (kind `Scheduled` \| `NRT`) | `2024-09-01` (GA) / `2024-01-01-preview` (NRT only) | rule name → slugged `ruleId` |
| **Microsoft Security Rules** | Analytics Rules | `alertRules` (kind `MicrosoftSecurityIncidentCreation`) | `2024-09-01` (GA) | rule name → namespaced, slugged `ruleId` |
| **Anomaly (ML) Rules** | Analytics Rules | `securityMLAnalyticsSettings` (kind `Anomaly`) | `2024-09-01` (GA) | setting name → slugged resource name |
| **Fusion Rule** | Analytics Rules | `alertRules` (kind `Fusion`) | `2024-09-01` (GA) | **kind match** — the live ruleId is system-assigned |
| **Automation Rules** | Automation | `automationRules` | `2024-09-01` (GA) | rule name → slugged `automationRuleId` |
| **Watchlists** (+ inline CSV items) | Content | `watchlists` | `2024-09-01` (GA, async) | alias |
| **Workbooks** | Content | `Microsoft.Insights/workbooks` (category `sentinel`) | `2023-06-01` (GA) | display name |
| **Source Control Repositories** | Content | `sourcecontrols` | `2024-09-01` (GA) | repository display name |
| **Hunting Queries & Saved Searches** | Hunting | `Microsoft.OperationalInsights/workspaces/savedSearches` | `2023-09-01` (GA) | name → slugged `savedSearchId` |
| **Data Connectors** | Data Collection | `dataConnectors` (first-party, tenant-based) | `2024-09-01` (GA) | connector id |
| **Threat Intelligence Indicators** | Threat Intelligence | `threatIntelligence/main/indicators` | `2024-09-01` (GA) | display name (server assigns the resource name) |
| **Product Settings** (UEBA / Entity Analytics / Anomalies / EyesOn) | Settings | `settings` | `2025-07-01-preview` | fixed setting name (singleton) |

PUT is an **upsert / full-document replace** for every type above, so each
deploy sends the complete desired state. Objects not declared on the canvas are
left untouched (non-destructive).

Highlights per type:

- **Analytics rules** – scheduled (KQL) rules: `query`, `queryFrequency`,
  `queryPeriod`, `triggerOperator`, `triggerThreshold`, `severity`, `tactics`,
  `enabled`, and suppression. NRT rules omit frequency/period/trigger (they run
  continuously) and are written against a preview api-version because `kind:NRT`
  is not part of the stable `alertRules` contract. The rule name is slugged into
  the ARM `ruleId` so re-deploying the same rule updates it in place.
- **Microsoft Security rules** – create Sentinel incidents from alerts raised by
  other Microsoft security products (`productFilter`), filtered by severity
  and/or alert display name. The `ruleId` is namespaced (`mssecurity--<slug>`) so
  it can never collide with an analytics-rule slug in the shared `alertRules`
  collection.
- **Anomaly (ML) rules** – enable/tune Sentinel's built-in ML anomaly
  detections: `settingsDefinitionId`, `settingsStatus` (Production/Flighting),
  run `frequency`, and customizable threshold observations.
- **Fusion rule** – the built-in "Advanced Multi-Stage Attack Detection"
  correlation rule. It is a per-workspace **singleton** that already exists on
  every onboarded workspace, so it is not created from a customer-typed name
  like the other `alertRules` kinds — deploy lists the workspace's alert rules
  and reconciles by `kind === "Fusion"`, whatever its live `ruleId` is. The only
  writable property is `enabled`; severity/tactics/scope are fixed by the
  built-in template.
- **Automation rules** – `triggeringLogic` (on Incidents/Alerts, when
  Created/Updated) plus a **ModifyProperties** action (set incident severity
  and/or status) and/or a **RunPlaybook** action (bind a Logic App playbook via
  `logicAppResourceId`, with an optional cross-tenant `tenantId`).
- **Watchlists** – created with inline CSV via `rawContent` + `contentType:
  text/csv` + `sourceType: Local`, in the *same* PUT as the watchlist itself.
  Watchlist PUT/DELETE are **asynchronous**, so each is followed by a bounded
  provisioning-state poll. Rollback of an *updated* watchlist restores
  **metadata only** — GET does not return `rawContent`, so prior item content
  cannot be recovered.
- **Hunting queries** – Log Analytics saved searches with category "Hunting
  Queries"; an optional function alias/parameters exposes the query as a
  reusable KQL function.
- **Data connectors** – the Microsoft first-party, tenant-based connectors
  (Entra ID Protection, Defender for Identity, Defender for Endpoint, Defender
  for Cloud Apps, Microsoft 365), each a `{ tenantId, dataTypes: {...state} }`
  body.
- **Threat intelligence indicators** – hand-authored STIX indicators
  (`pattern`/`patternType`, `confidence`, `threatTypes`, valid-from/until,
  tags), scoped to a fixed managed `source` so writes never touch
  TAXII/MDTI/connector-fed indicators. Creation is a POST that returns a
  server-assigned name; updates PUT to that name.
- **Product settings** – the four fixed-name singletons under
  `Microsoft.SecurityInsights/settings`: `Anomalies`/`EyesOn` (boolean
  `isEnabled`), `EntityAnalytics` (`entityProviders`), `Ueba` (`dataSources`).
  This operation group is preview-only at every api-version Microsoft has
  published it under, so it is pinned to `2025-07-01-preview` rather than the
  app-wide GA version.
- **Workbooks** – Azure Monitor workbooks scoped to the workspace (category
  `sentinel`); the entire workbook definition JSON is stored verbatim as
  `serializedData`.
- **Source control repositories** – GitHub / Azure DevOps repository, branch and
  content-type bindings for content-as-code sync. The repo credential (PAT /
  OAuth code / installation id) is **write-only** — sent on create/update, never
  returned on GET.

## Authentication

Auth is Azure Entra **OAuth2 client credentials**. Store the app registration in a
Veltrix credential:

- **Username** → the app **Client ID**
- **API token** → a **Client Secret**

The app exchanges these for an ARM bearer token at
`https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` with scope
`https://management.azure.com/.default` (tokens live ~1h and are cached).

### Required RBAC

The service principal needs the **Microsoft Sentinel Contributor** role
(`Microsoft.SecurityInsights/*`) scoped to the workspace **resource group**, plus
permission to write Log Analytics saved searches (hunting queries) and, for
run-playbook automation-rule actions, the **Microsoft Sentinel Automation
Contributor** role on the playbook's resource group.

### Settings

| Setting | Required | Notes |
| --- | --- | --- |
| Tenant ID | yes | Entra directory/tenant GUID |
| Subscription ID | yes | subscription that holds the workspace |
| Resource Group | yes | resource group of the Log Analytics workspace |
| Workspace Name | yes | the Log Analytics workspace Sentinel is enabled on |
| Azure Cloud | no | `commercial` (default), `gcc`, `gcc-high`, `dod` |
| Request Timeout (seconds) | no | per-request ARM timeout (default 30) |

GCC-High / DoD automatically use the sovereign ARM endpoint
`management.usgovcloudapi.net` and the `login.microsoftonline.us` authority.

## Coverage

This app was assessed against the full Microsoft Sentinel management surface
(`Microsoft.SecurityInsights` REST operation groups + the relevant
`Microsoft.OperationalInsights` savedSearches surface). What follows is a
complete accounting: everything managed, and everything deliberately excluded
with the sourced reason.

### Managed (12 configuration types)

| Sidebar group | Configuration types |
| --- | --- |
| **Analytics Rules** | Scheduled / NRT rules, Microsoft Security rules, Anomaly (ML) rules, Fusion rule |
| **Automation** | Automation rules (modify-properties + run-playbook) |
| **Content** | Watchlists (+ inline CSV items), Workbooks, Source control repositories |
| **Hunting** | Hunting queries & saved searches |
| **Data Collection** | Data connectors (first-party, tenant-based) |
| **Threat Intelligence** | Threat intelligence indicators |
| **Settings** | Product settings (UEBA / Entity Analytics / Anomalies / EyesOn) |

See the [Configuration types](#configuration-types) table above for the exact
ARM resource, api-version and reconciliation key behind each one.

### Deliberately excluded

Each of these was evaluated against the live `Microsoft.SecurityInsights` REST
operation-group listing and dropped for a specific, sourced reason — not
overlooked:

- **Content Hub / solution installs** (`contentPackages` / `productPackages` —
  the "Content Package - Install" and "Product Package - Install" operations).
  `Install` requires the caller to submit the catalog's own metadata verbatim —
  `contentProductId` ("should be generated based on the contentId, contentKind
  and the contentVersion"), `contentId`, `author`, `support`, `dependencies`,
  etc. — copied from Microsoft's or a partner's published catalog entry. That
  is installing a vendor's pre-built bundle at a pinned version, not authoring
  original detection content, so it does not round-trip as genuine
  config-as-code the way a hand-written analytics rule or watchlist does.
- **Granular watchlist items** (the `Watchlist Items` operation group — `Create
  Or Update` / `Delete` / `Get` / `List` for a single row). This is a real,
  fully round-trippable GA API, but it would just be a *second*, overlapping way
  to author the exact same data the `sentinel-watchlists` inline `rawContent`
  CSV already writes atomically in one PUT. Managing both would create two
  sources of truth for one watchlist's contents.
- **CCP / codeless data connectors, `Data Connector Definitions`, AWS and
  portal-only connector kinds.** These use a distinct, more complex codeless
  connector schema, most require tenant-level admin consent flows, and the
  surface is being superseded by the Defender portal. Only the simple,
  first-party `{ tenantId, dataTypes }` connector kinds are managed (see the
  Data Connectors row above).
- **Incidents, Incident Comments/Relations/Tasks, Entities, Bookmarks.** These
  are case-management / investigation *state* — one-shot actions (close an
  incident, add a comment, tag an entity) or read-only lookups — not
  declarative detection-and-response content. Managing them as code would mean
  reconciling live investigator activity against a "desired state" file, which
  is not a coherent config-as-code model.
- **Alert Rule Templates, Threat Intelligence Indicator Metrics.** Read-only
  catalog/statistics operation groups with no create-or-update operation.
- **Content / Product Metadata** (the `Metadata` operation group). This is
  content-hub publishing bookkeeping (author/support/source info) that a
  source-control sync (`sentinel-source-controls`) populates automatically from
  the connected repository — it is not something an engineer hand-authors
  independently of that sync.
- **Sentinel Onboarding States.** A one-time record of whether Microsoft
  Sentinel itself is enabled on the workspace. This app's `sentinel-workspace`
  component already assumes Sentinel is onboarded (it is the prerequisite for
  reaching any of the APIs above), so there is nothing repeatable to author here.
- **Logic App playbook code.** Automation rules attach a playbook by ARM
  resource id (`logicAppResourceId`); the playbook's own workflow definition is
  a `Microsoft.Logic/workflows` resource under an entirely different resource
  provider and is out of scope for this app.
- **Secret material** — source-control repository credentials (PAT / OAuth code
  / installation id) are accepted on write and never returned by GET, so they
  are never part of drift comparison or rollback restoration.

## Component

Register a **`sentinel-workspace`** component and attach the credential. The
Connections page (Settings) runs a connectivity test: the OAuth2 handshake plus a
GET of the Log Analytics workspace resource, classifying auth (token) vs RBAC
(`401/403`) vs wrong-address (`404`) failures.
