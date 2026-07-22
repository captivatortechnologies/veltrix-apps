# Changelog

All notable changes to the Tenable Vulnerability Management app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-07-22

### Added
- **Drift attribution ("who changed it + when").** When a configuration drifts
  from its deployed state, every drift now carries a best-effort `actor` —
  resolved from the Tenable **Audit Log** (`GET /audit-log/v1/events`) by
  correlating recent events to the drifted object by target id/name. The last
  change (create/update/delete) wins, falling back to the most recent event;
  the mapped actor records the name/email, when it happened, and the action.
  Attribution is **strictly best-effort**: it never throws, never blocks a drift
  check, and yields nothing when the audit log is inaccessible (it needs an
  admin API key and returns 403 otherwise), empty, or uncorrelated. The Veltrix
  connection identity is excluded so our own deploys are never mis-attributed as
  a manual change. Wired into all 18 configuration types' drift detection.

### Changed
- Grouped the **Configurations** sidebar into 7 collapsible sections — Scanning,
  Assets, Credentials & Connectors, Organization, Agents, Findings, and Access
  Control — so all 18 configuration types stay navigable. Sections collapse by
  default, remember whether you left them open, and always expand the one you're
  currently working in.
