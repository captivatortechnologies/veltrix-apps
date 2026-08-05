# Changelog

All notable changes to the Palo Alto Panorama app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.1 — 2026-08-05

Grouped all configuration types in the Configurations sidebar. Organization-only —
no change to any deploy/rollback/drift behavior.

- **Config sidebar groups** — the thirteen pre-existing types now join the same
  Objects / Policies / Security Profiles / Logging groups introduced for the 1.3.0
  additions, instead of rendering as a flat list above them: address/service objects
  and groups, tags, application groups → Objects; security and NAT rules → Policies;
  security-profile groups and AV / anti-spyware / URL-filtering / WildFire profiles →
  Security Profiles.

## 1.3.0 — 2026-08-05

### Added
Ten new configuration types, closing the audited coverage gaps found against
the current PAN-OS REST API surface (cross-referenced with the
[pypanrestv2](https://github.com/mrzepa/pypanrestv2) client and
[terraform-provider-panos](https://github.com/PaloAltoNetworks/terraform-provider-panos)
resource schemas — see README Coverage). Each reuses the shared `lib/panorama`
client and staged-commit pipeline and ships the full handler set — validate,
deploy (idempotent upsert by name with rollback data), rollback, health check,
drift detection and status.

- **Schedules** (`/Objects/Schedules`). Non-recurring date-time ranges, daily
  time ranges, or weekly per-day time ranges. Referenced by name from any rule
  type's `schedule` field.
- **Custom URL Categories** (`/Objects/CustomURLCategories`). "URL List" (raw
  URLs/domains) or "Category Match" (bundle of existing categories).
- **External Dynamic Lists** (`/Objects/ExternalDynamicLists`). ip/domain/url
  source types with a recurring refresh schedule (5-minute/hourly/daily/weekly/
  monthly), exception list and certificate profile reference. Authenticated
  source URLs are not modeled — PAN-OS masks the password on every read.
- **Vulnerability Protection Profiles** (`/Objects/VulnerabilityProtectionSecurityProfiles`).
  Single rule: severity/CVE/category/threat-name/host, action (as a PAN-OS
  choice element) and packet capture — closes the profile category
  `panorama-security-profile-groups` has referenced since 1.2.0.
- **File Blocking Profiles** (`/Objects/FileBlockingSecurityProfiles`). Single
  rule: applications/file-types/direction and a plain-string action (alert,
  block, continue) — closes another profile category referenced since 1.2.0.
- **Data Filtering Profiles** (`/Objects/DataFilteringSecurityProfiles`).
  Single rule: a referenced Custom Data Pattern object, direction,
  applications/file-types and alert/block thresholds — closes the last
  remaining profile category referenced since 1.2.0.
- **Log Forwarding Profiles** (`/Objects/LogForwardingProfiles`). Single
  match-list entry: log type, optional filter, and forwarding to Panorama
  and/or existing syslog/email/HTTP/SNMP-trap server profiles — closes the
  profile `panorama-security-rules`' `log_setting` field has referenced by
  free-text name since day one.
- **Decryption Rules** (`/Policies/DecryptionPreRules`). SSL Forward Proxy, SSL
  Inbound Inspection (with referenced certificate names) or SSH Proxy, with
  no-decrypt/decrypt action and TLS handshake logging.
- **Policy-Based Forwarding Rules** (`/Policies/PolicyBasedForwardingPreRules`).
  Forward (egress interface, IP/FQDN next hop, path monitor with
  disable-if-unreachable) / discard / no-PBF / forward-to-vsys actions, with
  symmetric return and its eligible next-hop address list.
- **Authentication Rules** (`/Policies/AuthenticationPreRules`). Captive
  Portal / MFA enforcement matched by zone, address, user and URL category,
  referencing an existing Authentication Enforcement object by name.

### Fixed
- README "What it manages" table and "Scope & limitations" section were stale
  since the 1.2.0 profile additions (still described security profiles as
  "intentionally out of scope" after they had already shipped). Replaced with
  an audited **Coverage** section: every managed type with its REST endpoint,
  plus a sourced, honest list of what was considered and dropped.

### Notes
- Every "single-rule" profile type in this app (Anti-Spyware, WildFire,
  Vulnerability, File Blocking, Data Filtering) models the common one-rule-
  per-profile case; multi-rule profiles are not represented. Log Forwarding
  Profiles model one match-list entry per profile. PBF rules match by zone
  only (not interface). None of the five rule types (Security, NAT,
  Decryption, PBF, Authentication) model per-device targeting, administrative
  tags or active/active HA device binding — a consistent scope across the
  whole rule family. Commit is never modeled as a configuration type — it is
  the one-shot activation action every deploy/rollback already performs.
- Zones, Templates/Template Stacks, Device Groups, LDAP/RADIUS/Authentication
  Profiles and GlobalProtect Gateway/Portal were evaluated and dropped: they
  either use a Network/Device/Panorama-category location model this app's
  device-group/shared scoping cannot express, or (LDAP/RADIUS, GlobalProtect)
  carry secret/certificate material. See README Coverage for the full,
  per-candidate reasoning.

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
