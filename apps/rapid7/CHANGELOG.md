# Changelog

All notable changes to the Rapid7 InsightVM app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-05

### Added
- **Four new InsightVM configuration types**, closing genuine gaps found in a
  research-first exhaustiveness pass against the console API v3 surface
  (verified against Rapid7's official OpenAPI-generated Python client, since
  the console's own ReDoc reference renders its spec client-side):
  - **Policy Overrides** (`/policy_overrides`) — override a Policy Manager
    (compliance benchmark) rule's result for one asset, one asset until its
    next scan, or every asset. Reconciled by (rule id, scope type, asset id);
    create/skip only (the console offers no in-place update) and deleted on
    rollback.
  - **Report Configurations** (`/reports`) — define a report's template,
    format, and scope (sites / asset groups / tags, declared by name and
    resolved to ids at deploy time), plus any other report field (frequency,
    email, storage, baseline, …) as an escape-hatch JSON object. Manages the
    report's configuration only — it never triggers generation
    (`/reports/{id}/generate`) or reads output history.
  - **Sonar Queries** (`/sonar_queries`) — define a saved Project Sonar
    internet-scan search (criteria filters) used to discover assets. Manages
    the saved query only — running it and reading its discovered-asset
    results are one-shot/read actions, not configuration.
  - **Console Users** (`/users`) — define local console users: login, name,
    email, enabled state, role assignment (with all-sites / all-asset-groups /
    superuser flags), and explicit site/asset-group access (declared by name).
    The password is write-only and required by the console on every write, so
    it is always re-sent on deploy and never read back, diffed or stored — an
    updated user's password rotates on every redeploy, and an in-place update
    cannot be safely rolled back (see the rollback.ts header for why).
- New **Findings**, **Reporting**, **Assets** and **Administration** sidebar
  groupings for the four types above (Policy Overrides joins the existing
  Findings group; Sonar Queries joins Assets).
- README **Coverage** section: a full breakdown of every managed configuration
  type by source endpoint, plus an honest list of considered-and-dropped
  candidates on both the InsightVM and InsightIDR sides (policy/report-template
  read-only APIs, discovery connections, blackout windows, custom threat
  intelligence, log search, alert triage, investigations) with the evidence
  for each decision.

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
