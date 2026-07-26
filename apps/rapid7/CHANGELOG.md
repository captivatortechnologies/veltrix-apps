# Changelog

All notable changes to the Rapid7 InsightVM app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-26

### Added
- **InsightIDR (Insight Platform cloud) coverage** — the app now spans Rapid7's
  cloud SIEM alongside the on-prem console, via the region-scoped Insight
  Platform Detection Rules API v1 (`https://<region>.api.insight.rapid7.com`,
  `X-Api-Key` auth). Two new configuration types, targeting a new
  `insightidr-org` component type:
  - **InsightIDR Detection Rule Exceptions** — declare rule exceptions
    (`/idr/v1/rules/{rrn}/rule-exceptions`) as code. Each exception is attached
    to a parent detection rule referenced by name and tunes its action/priority
    for matching users, assets or IPs, using either SIMPLE key-value conditions
    or a LEQL query. Reconciled by (rule name, exception name); created when
    missing, rolled back by deletion.
  - **InsightIDR Detection Rule Settings** — set a detection rule's action
    (off / tracks notable events / creates investigations / creates alerts /
    assess activity) and optional investigation priority
    (`/idr/v1/rules/update`). Reconciled by rule name; only changed fields are
    written, and rollback restores the prior values.
- **InsightIDR Region** app setting and an extended connection test that probes
  `GET /validate` with the API key when the connection targets an Insight
  Platform host (the InsightVM console test is unchanged).

## 1.1.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 4 collapsible sections — Scanning,
  Assets, Credentials, and Findings — so all 9 configuration types stay
  navigable. Sections collapse by default, remember whether you left them open,
  and always expand the one you're currently working in.
