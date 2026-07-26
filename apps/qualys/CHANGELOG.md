# Changelog

All notable changes to the Qualys app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-26

### Added
- **Three new configuration types**, closing audited coverage gaps (issue #16).
  Each ships the full handler set (validate, deploy, rollback, healthCheck,
  driftDetect, getStatus) with idempotent upsert by natural key and
  deploy-captured `rollbackData`, matching the existing types.
  - **Dynamic search lists** (`qualys-dynamic-search-lists`) — QID sets selected
    by criteria that Qualys re-evaluates over time, via the classic v2 API
    `POST /api/2.0/fo/qid/search_list/dynamic/` (`action=create|update|delete`,
    read via `action=list`, block `DYNAMIC_LIST`). Reconciled by title. Title,
    global and comments are first-class fields; every other criteria parameter
    (severities, categories, CVSS, CVEs, dates, compliance types, …) is supplied
    as a flat JSON object and sent verbatim.
  - **VM option profiles** (`qualys-option-profiles`) — how a scan runs (ports,
    performance, detection scope), via the classic v2 API
    `POST /api/2.0/fo/subscription/option_profile/vm/`
    (`action=create|update|delete`) with the live set read from
    `GET /api/2.0/fo/subscription/option_profile/?action=export`
    (`option_profile_type=user`, block `OPTION_PROFILE` / `BASIC_INFO`,
    title = `GROUP_NAME`). Reconciled by title. Global/default are first-class;
    every other scan setting is supplied as a flat JSON object.
  - **Asset tags & tag rules** (`qualys-asset-tags`) — static or dynamic tags,
    via the Asset Management & Tagging **QPS REST API** (JSON)
    `POST /qps/rest/2.0/{create,update,search,delete}/am/tag`. Reconciled by
    name. Supports `ruleType` (STATIC, NAME_CONTAINS, NETWORK_RANGE, OS_REGEX,
    OPEN_PORTS, INSTALLED_SOFTWARE, VULN_EXIST, ASSET_SEARCH, GLOBAL_ASSET_VIEW,
    CLOUD_ASSET, BUSINESS_INFORMATION, GROOVY) + `ruleText`, color and
    criticality score.
- **QPS/JSON transport** added to the shared Qualys client
  (`lib/qualys.ts`): a `postJson` method (ServiceRequest/ServiceResponse) and
  `qpsWriteError` / `qpsDataList` / `qpsHasMoreRecords` helpers, plus a `get`
  helper for query-string reads (option-profile export). The classic form/XML
  path is unchanged.

### Notes
- **Policy Compliance policies were intentionally not added.** Creating a policy
  requires importing a full policy XML document, and — critically — deleting a
  policy is only available through the separate Bearer-token
  `DELETE /pcas/v3/policy` (PCAS v3) REST API, which is incompatible with this
  app's HTTP Basic classic client. Without a compatible delete, the
  create/rollback contract used by every other type here cannot be honored, so
  the gap is documented rather than shipped in a degraded form.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Qualys object (asset groups, static search lists, scan schedules), each
  reported difference is now annotated with the person who made the last manual
  change and when, resolved from the Qualys **User Activity Log**. The platform
  stores the `actor` on each diff and the drift view renders it, so a drift alert
  answers *who* and *when*, not just *what*.
  - Attribution queries the classic v2 User Activity Log once per drifted object
    (`POST /api/2.0/fo/activity_log/?action=list&output_format=XML`
    `&since_datetime=<~7d>&truncation_limit=50`) using the same Basic-auth
    service account and `X-Requested-With` header as every other call, and
    correlates entries CLIENT-SIDE to the drifted object by matching its
    name/id inside the entry's `DETAILS`/`ACTION` text (the activity log has no
    structured resource id).
  - It picks the most recent event with an acting login (`USER_NAME`), preferring
    change-type actions (`create`, `update`, `delete`, `add`, `remove`, `edit`,
    …) and falling back to the most recent human event otherwise. `name` comes
    from `USER_NAME`, the timestamp from `DATE`, and the event type from
    `ACTION`.
  - Veltrix's own deploys run through the connection's Qualys service account, so
    a change WE made is excluded via the connection login — the attribution
    reflects the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a non-OK response (for example when the service
    account's role lacks Activity Log / API access), an empty log, or no usable
    event, the diff is reported without an actor and the drift view shows "—". It
    never fabricates. Only objects that actually drifted are attributed (one
    activity-log query per drifted object).
