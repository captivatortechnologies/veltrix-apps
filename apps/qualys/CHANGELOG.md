# Changelog

All notable changes to the Qualys app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-05

### Added
- **Four new configuration types**, closing a config-as-code exhaustiveness
  audit against the Qualys API (VM/PC) User Guide. Each ships the full handler
  set (validate, deploy, rollback, healthCheck, driftDetect, getStatus) with
  idempotent upsert by natural key and deploy-captured `rollbackData`.
  - **Authentication records** (`qualys-auth-records`) — records used for
    authenticated (trusted) scanning, via the classic v2 API
    `POST /api/2.0/fo/auth/<type>/` (`action=create|update|delete`, read via
    `action=list`). Reconciled by (technology, title) — each of the 22
    supported technologies (Unix/Cisco/Checkpoint, Windows, Oracle, Oracle
    Listener, Oracle WebLogic, SNMP, VMware, MS SQL, MySQL, PostgreSQL, IBM
    DB2, Docker, HTTP, Network Device SSH, MongoDB, Tomcat, Apache, IIS, IBM
    WebSphere, Sybase, Palo Alto Firewall, MS Exchange) is a separate
    endpoint/namespace. Title, target IPs and comments are first-class;
    **every credential field (username, password, vault/Kerberos settings,
    …) is a single write-only JSON field — sent on every deploy, never read
    back, diffed or logged**, matching this app's `password` field-type
    convention. ~30 niche/rarely-used record types (DataStax, MarkLogic,
    Neo4j, Cassandra, InformixDB, Kubernetes, vCenter mapping, …) are left to
    a future pass.
  - **Custom networks** (`qualys-networks`) — the "Network Support" feature's
    networks, via the classic v2 API `POST /api/2.0/fo/network/`
    (`action=create|update`, list via `action=list`). Reconciled by name.
    Closes the gap referenced by this app's existing `network_id` fields
    (asset groups, option profiles, auth records). **There is no delete
    network API** — only Create/Update/List/Assign-Scanner-Appliance are
    documented — so a created network can only be renamed on rollback, never
    removed; this is reported, not silently swallowed.
  - **VM report templates** (`qualys-report-templates`) — Scan, Patch and Map
    report templates, via the classic v2 API
    `POST|PUT /api/2.0/fo/report/template/<scan|patch|map>/`. **The one
    config type in this app whose write body is a literal XML DOCUMENT**
    (`Content-Type: text/xml`), not form parameters — and Update uses HTTP
    PUT, a first for this app's shared client (`QualysClient.sendXmlBody`).
    This app manages only the TITLE section (title, owner); every other
    section (TARGET, DISPLAY, FILTER, SERVICESPORTS, USERACCESS, …) is a
    free-form XML fragment passed through verbatim — the exact shape Export
    returns is exactly what Create/Update expect, so it round-trips safely
    without this app needing to interpret it. Reconciled by (type, title) via
    the separate `/msp/report_template_list.php` metadata list, because
    Export never returns a template's own id. **Quirk:** success is reported
    by a human-readable message IN `<CODE>` (e.g. "…Created Successfully
    [89876]") — the OPPOSITE of every other classic-API call in this app,
    where a populated `<CODE>` means failure; handled locally
    (`reportTemplateWriteError`), not added to the shared `qualysWriteError`.
    **PCI Scan Template was evaluated and dropped**: its value in the shared
    metadata list's `<TEMPLATE_TYPE>` field is not documented distinctly from
    Scan/Compliance in the available API guide, so it cannot be safely
    reconciled by title without risking a cross-type collision.
  - **Users** (`qualys-users`) — user accounts, via the classic API
    `/msp/user.php` (`action=add|edit|deactivate`) and `/msp/user_list.php`
    (list) — a different API family from `/api/2.0/fo/...` with its own
    `USER_OUTPUT`/`<RETURN status="...">` envelope. Reconciled by **email**,
    not `login` — Qualys generates the login itself on `action=add` (it
    cannot be chosen), so it is a live-resolved artifact rather than desired
    state. **There is no delete-user API** — only Activate/Deactivate — so a
    created user's rollback best-effort deactivates it (and a freshly
    invited user stays "Pending Activation", which Qualys refuses to
    deactivate, until they first log in); an updated user's rollback restores
    only first/last name and job title (the fields this app can read back).
- **Raw-XML transport** added to the shared Qualys client (`lib/qualys.ts`):
  `QualysClient.sendXmlBody(method, path, queryParams, xmlBody)` sends a
  literal XML document as the request body (`Content-Type: text/xml`) with
  the action verb in the query string, and supports HTTP PUT — used only by
  VM report templates. The classic form/XML and QPS/JSON paths are unchanged.

### Notes
- **Cloud Agent Configuration Profiles were evaluated and dropped.** Its API
  (`<qualys_base_url>/caui/v1/config-profiles`) requires **Bearer-token
  OAuth**, not HTTP Basic — incompatible with this app's credential model
  (the same reasoning that already excluded Policy Compliance policies'
  delete endpoint in 1.2.0).
- **Host assets were evaluated and dropped.** The Asset Management QPS API
  can create host assets, but they are scan-populated inventory records that
  Qualys' own scanning/Cloud Agent continuously overwrite — treating them as
  desired state would generate perpetual false-positive drift. The API
  exists for CMDB import/bootstrap, not steady-state configuration.
- **Business units and distribution groups were evaluated and dropped.**
  Neither has a documented create/update/delete endpoint anywhere in the
  Qualys API (VM/PC) User Guide; the Add/Edit User API explicitly states
  "business units may be created using the Qualys user interface only."

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
