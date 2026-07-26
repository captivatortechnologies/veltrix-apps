# Changelog

All notable changes to the Palo Alto Panorama app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-26

### Added
Seven new configuration types, closing the audited coverage gaps (issue #12).
Each reuses the shared `lib/panorama` client and staged-commit pipeline (write to
the Panorama candidate config via REST, commit via the XML API when `auto_commit`
is on) and ships the full handler set — validate, deploy (idempotent upsert by
name with rollback data), rollback, health check, drift detection and status.

- **NAT Rules** (`/Policies/NATPreRules`). IPv4 NAT pre-rules: original-packet
  match (zones, source, destination, service, destination interface) plus source
  translation (dynamic-ip-and-port with translated addresses or an egress
  interface address, dynamic-ip, static-ip with optional bi-directional) and
  destination translation (translated address + optional port). Drift compares a
  normalized, order-insensitive translation summary so member re-ordering is not
  reported as drift.
- **Application Groups** (`/Objects/ApplicationGroups`). Name + member App-IDs /
  application filters / nested groups.
- **Security Profile Groups** (`/Objects/SecurityProfileGroups`). Bundle one
  profile of each type — antivirus, anti-spyware, vulnerability, URL filtering,
  file blocking, WildFire analysis and data filtering.
- **Antivirus Profiles** (`/Objects/AntivirusSecurityProfiles`). Virus and
  WildFire signature actions applied uniformly across the protocol decoders
  (ftp, http, http2, imap, pop3, smb, smtp).
- **Anti-Spyware Profiles** (`/Objects/AntiSpywareSecurityProfiles`). A single
  rule: matched severities, action (as a PAN-OS choice element), packet capture,
  category and threat-name filters.
- **URL Filtering Profiles** (`/Objects/URLFilteringSecurityProfiles`). URL
  categories bucketed by action (block, alert, allow, continue, override), with
  safe-search enforcement and container-page-only logging; validation rejects a
  category placed in more than one bucket.
- **WildFire Analysis Profiles** (`/Objects/WildFireAnalysisSecurityProfiles`). A
  single analysis rule — applications, file types, direction and analysis
  location (public or private cloud).

### Notes
- The anti-spyware and WildFire analysis types model a single rule per profile
  (the common case). Antivirus applies one action set uniformly to all decoders.
  Multi-rule profiles, per-decoder overrides, botnet-domain / DNS-security
  policies, ML-engine and threat-exception settings, and NAT fallback / dynamic
  destination translation / DNS rewrite / nat64 / nptv6 are not represented.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Panorama object (tags, address & service objects, address & service
  groups, security pre-rules), each reported difference is now annotated with the
  administrator who made the last change and when. The platform stores the
  `actor` on each diff and the drift view renders it, so a drift alert answers
  *who* and *when*, not just *what*.
  - Attribution reads the PAN-OS **config audit log** (`type=log&log-type=config`)
    — an asynchronous log job that is started, polled briefly for the recent rows
    of the drifted object, then correlated to that object by matching its name in
    the row's `path` / `full-path` xpath at a token boundary (so "web" is never
    mistaken for "web-server"). The row's `admin`, `cmd` and `time_generated`
    become the actor's name, event type and timestamp.
  - Real object edits (`set` / `edit` / `delete` / `rename` / `move` / …) are
    preferred over activation-only commands (`commit` / `validate`), and only
    succeeded rows count, so the actor is whoever made the change rather than
    whoever pushed it.
  - Veltrix's own deploys are recorded in the config log under the connection
    admin, so a change WE made is excluded via that admin username — the
    attribution reflects the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws, and never slows down or
    fails a drift check. The config-log job is tightly bounded and, on any error,
    an unreachable or timed-out log, or no usable row (for example a deleted
    object, or a log the admin role cannot read), the diff is reported without an
    actor and the drift view shows "—". Only objects that actually drifted are
    attributed (one bounded query per drifted object).
