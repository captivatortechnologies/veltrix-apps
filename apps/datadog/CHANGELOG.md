# Changelog

All notable changes to the Datadog app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
