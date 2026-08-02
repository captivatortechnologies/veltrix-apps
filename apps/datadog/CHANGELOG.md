# Changelog

All notable changes to the Datadog app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
