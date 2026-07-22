# Changelog

All notable changes to the Microsoft Sentinel app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

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
