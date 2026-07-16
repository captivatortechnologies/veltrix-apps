# Microsoft Sentinel

Manage Microsoft Sentinel detection and response content **as code** through the
Azure Resource Manager (ARM) API. Authoring happens in the Veltrix Configuration
Canvas; every write goes through the Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback).

Microsoft Sentinel is managed through **Azure Resource Manager**
(`https://management.azure.com`), **not** Microsoft Graph. All resources live
under:

```
/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/
  workspaces/{ws}/providers/Microsoft.SecurityInsights/...
```

## Configuration types

| Config type | ARM resource | api-version | Reconcile key |
| --- | --- | --- | --- |
| **Analytics Rules (Scheduled)** | `alertRules` (kind `Scheduled`) | `2024-09-01` (GA) | rule name → slugged `ruleId` (idempotent PUT) |
| **Automation Rules** | `automationRules` | `2024-09-01` (GA) | rule name → slugged `automationRuleId` |
| **Watchlists** | `watchlists` (+ inline CSV items) | `2024-09-01` (GA, async) | alias |

All three use `api-version=2024-09-01` (pinned app-wide). PUT is an **upsert /
full-document replace**, so each deploy sends the complete desired state. Objects
not declared on the canvas are left untouched (non-destructive).

- **Analytics rules** – scheduled (KQL) rules: `query`, `queryFrequency`,
  `queryPeriod`, `triggerOperator`, `triggerThreshold`, `severity`, `tactics`,
  `enabled`, and suppression. The rule name is slugged into the ARM `ruleId` so
  re-deploying the same rule updates it in place.
- **Automation rules** – `triggeringLogic` (on Incidents/Alerts, when
  Created/Updated) plus a single **ModifyProperties** action (set incident
  severity and/or status). Running playbooks (`RunPlaybook`) is intentionally
  **out of scope** for v1 — it requires the Sentinel service account to hold
  explicit permissions on the playbook's resource group.
- **Watchlists** – created with inline CSV via `rawContent` + `contentType:
  text/csv` + `sourceType: Local`. Watchlist PUT/DELETE are **asynchronous** at
  api-version 2024-09-01, so each is followed by a bounded provisioning-state
  poll (up to ~60s). Rollback of an *updated* watchlist restores **metadata
  only** (display name, provider, search key) — GET does not return `rawContent`,
  so prior item content cannot be recovered.

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
(`Microsoft.SecurityInsights/*`) scoped to the workspace **resource group**.

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

## Deliberately out of scope

These were assessed and left out because they are preview or not genuinely
config-as-code via a stable API:

- **NRT, ML Behavior Analytics, and Threat-Intelligence analytics rule kinds** —
  present only in preview api-versions (the GA `alertRules` surface is
  `Scheduled` / `Fusion` / `MicrosoftSecurityIncidentCreation`).
- **Threat-intelligence indicator upload** — preview, on a separate data-plane
  host with a different token audience.
- **Data connectors** — kind-locked, first-party connectors need tenant-level
  admin consent, and the surface is being superseded by the Defender portal.
- **Hunting queries** — these are Log Analytics `savedSearches` under a different
  resource provider (`Microsoft.OperationalInsights`), not `SecurityInsights`.

## Component

Register a **`sentinel-workspace`** component and attach the credential. The
Connections page (Settings) runs a connectivity test: the OAuth2 handshake plus a
GET of the Log Analytics workspace resource, classifying auth (token) vs RBAC
(`401/403`) vs wrong-address (`404`) failures.
