# Changelog

All notable changes to the Datadog app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added
- **Exhaustion pass — 7 new config types, every remaining verified writable
  Datadog config surface this app's research could confirm.** See the
  README's **Coverage** section for the full managed/excluded breakdown.
- **Security Filters (`security-filters`, group "Detection").** Full
  lifecycle for `/api/v2/security_monitoring/configuration/security_filters[/{id}]`
  (a JSON:API resource distinct from Suppressions — a filter excludes logs
  from security analysis entirely, rather than silencing a signal),
  reconciled by name with optimistic-lock `version`, exclusion-filter drift,
  rollback, and best-effort protection for a live filter marked
  `is_builtin` (unverified field name, flagged).
- **Sensitive Data Scanner (`sensitive-data-scanner`, group "Data
  Security").** Scanning groups + nested scanning rules over the JSON:API
  relationship graph at `/api/v2/sensitive-data-scanner/config/{groups,rules}`.
  One canvas item = one group; rules are authored as a JSON array and fully
  synced (a live rule no longer declared is deleted). Rollback recreates a
  pruned rule, restores an updated rule's prior attributes, and deletes a
  created rule/group. **Scope note:** group/rule ordering
  (`PATCH .../config`) is not managed.
- **Log Archives (`log-archives`, group "Log Management").** Full lifecycle
  for `/api/v2/logs/config/archives[/{archive_id}]`, reconciled by name. The
  cloud `destination` (S3/GCS/Azure) references a pre-configured Datadog
  cloud integration by non-secret identifiers only. **Scope note:** archive
  order and reader-role grants are not managed.
- **Log-Based Metrics (`log-metrics`, group "Log Management").** Full
  lifecycle for `/api/v2/logs/config/metrics/{metric_id}`, where the metric
  `id` is its own permanent name — reconciled by direct lookup, not
  list+match. `compute.aggregation_type`/`compute.path` are documented
  create-only and are never sent on `PATCH`.
- **Log Indexes (`log-indexes`, group "Log Management").** Full lifecycle
  for `/api/v1/logs/config/indexes/{name}`, where the index name is its
  permanent identity (direct lookup). Update is a full-replace `PUT`.
  **Scope note:** index order is not managed.
- **SLOs (`slos`, group "Monitors").** Full lifecycle for
  `/api/v1/slo[/{slo_id}]`, reconciled by name, supporting both `metric` and
  `monitor` SLO types with timeframe thresholds. `time_slice` is accepted
  but not deep-validated (flagged — no confirmed request-body reference).
  Delete never forces through a still-referenced SLO.
- **Roles (`roles`, group "Access").** Full lifecycle for
  `/api/v2/roles[/{role_id}]` plus the `.../permissions` relationship,
  reconciled by name. Permission names are resolved to Datadog's opaque
  permission ids via `GET /api/v2/permissions`. **ADDITIVE ONLY:**
  permissions are granted but never revoked — Datadog automatically adds
  several baseline read permissions (Dashboards, Monitors, SLOs, …) to every
  new role, and a full grant/revoke sync would fight that baseline on every
  deploy. Drift detection matches: only a missing declared permission is
  reported.
- **Dropped, not built: Downtimes (`/api/v2/downtime`).** A time-bound
  operational action (mute a monitor's alerting for a window), not a
  durable config object — and this app's rollback model (revert to prior
  full state) would risk silently re-enabling a monitor's alerting during a
  human-declared incident/maintenance window. See the README Coverage
  section for the full reasoning.
- All 7 new config types ship the full handler set (validate, deploy,
  rollback, healthCheck, driftDetect, getStatus) and reuse
  `lib/datadogApi.ts` unchanged.

### Corrected
- The stated Log Pipelines path in the original wave-3 ask
  (`/api/v1/logs/pipelines`) is actually `/api/v1/logs/config/pipelines`
  (already reflected in the 0.2.0 release); Sensitive Data Scanner,
  Log Archives, Log Metrics and Log Indexes paths were all verified
  independently against their official per-operation doc pages before
  being wired up.

## 0.2.0 — 2026-08-02

### Added
- **Log Pipelines (`log-pipelines`, group "Log Management").** Manage Datadog
  Log Management pipelines as code through
  `GET`/`POST`/`PUT`/`DELETE /api/v1/logs/config/pipelines[/{pipeline_id}]`,
  reconciled by pipeline name. Processors are authored as a JSON array
  (17 documented processor types validated at the common envelope level —
  `type`/`is_enabled`; type-specific fields pass through to Datadog's API).
  Datadog-managed **integration pipelines** (`is_read_only`) are protected —
  a deploy that matches one by name fails loudly rather than modifying it.
  **Scope note:** pipeline **order** is a separate singleton resource
  (`GET`/`PUT /api/v1/logs/config/pipeline-order`) and is explicitly NOT
  managed by this release — a newly created pipeline is appended by Datadog
  and may need manual reordering.
- **Monitors (`monitors`, group "Monitors").** Manage Datadog Monitors as
  code through `GET`/`POST`/`PUT`/`DELETE /api/v1/monitor[/{monitor_id}]`,
  reconciled by monitor name. Validates name/type/query as required,
  priority (1-5), and the well-documented `options` sub-fields
  (thresholds, notify_no_data, renotify_interval, …). **Scope note:**
  `type` is modeled as free text with a WARNING (not an error) when it
  doesn't match this app's well-documented common set — research could not
  fully confirm Datadog's complete monitor-type enum against one
  authoritative source, so this app does not risk rejecting a legitimate
  type it failed to enumerate. Delete never passes `force=true`.
- **Security Monitoring Suppressions (`security-monitoring-suppressions`,
  group "Detection").** Manage Datadog suppression rules — silence signals
  from matching detection rules without disabling them — as code through the
  JSON:API resource at
  `GET`/`POST`/`PATCH`/`DELETE /api/v2/security_monitoring/configuration/suppressions[/{id}]`,
  reconciled by rule name. A non-`editable` live suppression is protected
  from modification. This app always sends every managed attribute on
  `PATCH` (the endpoint itself supports a true partial update), so each
  deploy fully replaces the declared state.
- **`security-monitoring-rules` now carries `group: "Detection"`** alongside
  the new suppressions type, grouping both Security Monitoring config types
  together in the Configuration Canvas sidebar.
- All three new config types ship the full handler set (validate, deploy,
  rollback, healthCheck, driftDetect, getStatus) and reuse `lib/datadogApi.ts`
  unchanged.

### Corrected
- The Suppression Rules path is
  `/api/v2/security_monitoring/configuration/suppressions` — a
  `configuration/` path segment that is easy to miss from the endpoint name
  alone; verified directly against the official per-operation doc pages.

## 0.1.0 — 2026-08-02

### Added
- **Foundation release.** Manage Datadog **Security Monitoring** detection
  rules (`security-monitoring-rules`) as code through the Security Monitoring
  Rules API (`GET`/`POST`/`PUT`/`DELETE /api/v2/security_monitoring/rules`),
  reconciled by rule name, with the full handler set (validate, deploy,
  rollback, healthCheck, driftDetect, getStatus).
- Supports all five documented rule types — `log_detection`,
  `workload_security`, `application_security`, `signal_correlation`,
  `cloud_configuration` — with deep validation of the shared
  queries/cases/options shape for the first three, and universal
  (`cases[].status`, JSON-shape) validation for the two structurally
  different types.
- Deploy captures each updated rule's full prior state AND its current
  optimistic-concurrency `version` before writing; rollback restores it,
  re-reading the version current at restore time.
- Authentication via two static keys (`DD-API-KEY` + `DD-APPLICATION-KEY`);
  multi-site support (`datadoghq.com`, `datadoghq.eu`, `us3`/`us5.datadoghq.com`,
  `ap1`/`ap2.datadoghq.com`, `ddog-gov.com`, and any future site) via a
  `datadog-org` component whose hostname holds the bare site value.
- Connection-level connectivity test via `GET /api/v1/validate`.
