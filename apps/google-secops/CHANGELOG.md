# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.6.0 — 2026-08-05

### Added
- **Findings Refinement Deployments** configuration type — manage the
  deployment state of a findings refinement (detection exclusion) as code: `enabled`
  (apply continuously), `archived` (cannot be set together with enabled), and
  `detectionExclusionApplication` — which detectors (detection rules by
  display name, plus raw curated-rule-set / curated-rule resource paths) the
  exclusion is scoped to. Identity is the refinement's `displayName` — the
  same identity the Findings Refinements type uses; the refinement must
  already exist. A deployment is a singleton sub-resource (never created or
  deleted), so there is no reconcile-delete — a removed spec is left at its
  last-set state and rollback restores the prior state (the same
  content-vs-state split already used by Rule Deployments). Verified against
  `google_chronicle_findings_refinement_deployment` in Google's own
  `terraform-provider-google` (`GoogleCloudPlatform/magic-modules`
  `mmv1/products/chronicle/FindingsRefinementDeployment.yaml`) — this app's
  Findings Refinements type previously only disabled + archived a refinement's
  deployment as a reconcile side effect; it did not expose deployment state or
  detector scoping as a first-class, user-declared config surface.
- **Native Dashboards** configuration type — manage Chronicle SIEM "Native
  Dashboards" as code: the dashboard container (display name, description,
  `access` — DASHBOARD_PRIVATE/DASHBOARD_PUBLIC, pinned) plus its global
  filters (time-range and entity/UDM filters shared across the dashboard's
  charts). Identity is the display name (the dashboardId is server-assigned);
  created/updated/deleted, with app-created dashboards deleted on reconcile. A
  matched dashboard whose type is not `CUSTOM` (Google-curated, marketplace, or
  legacy Looker-era PUBLIC/PRIVATE dashboards) is reported and left untouched.
  SCOPE: chart CONTENT (the visualization/query definitions behind each tile)
  is intentionally out of scope this pass — charts have their own
  create/update/delete lifecycle via custom `addChart`/`editChart`/`removeChart`
  RPCs on the dashboard, backed by an extremely deep and still-evolving
  visualization schema (per-axis/series/legend/table/button/markdown/map/
  drill-down configuration, confirmed via the same magic-modules source).
  Verified against `google_chronicle_native_dashboard` /
  `google_chronicle_dashboard_chart` in the same `terraform-provider-google`
  source (`NativeDashboard.yaml`, `DashboardChart.yaml`).
- README **Coverage** section — every configuration type this app manages
  (grouped) plus every genuinely-excluded Chronicle/SecOps surface, each with
  a sourced reason: SOAR (Siemplify) case-management resources (cases,
  environments, integrations, legacy SOAR users, SOAR domains/networks, `SOC
  Roles` RBAC, custom lists, alert grouping) are out of scope for this
  SIEM-only app; one-shot execution resources (retrohunts, data exports);
  read-only/reference data (ingestion log labels/namespaces, feed source-type
  schemas, execution errors, coverage details); user-preference/transient
  state (saved column sets, search queries, ad-hoc dashboard-query execution);
  and a small set of confirmed-but-unverified-schema resources (entities
  blocklists, enrichment controls, property schema definitions) deliberately
  not guessed at.

## 0.5.0 — 2026-07-26

### Added
- **Data Feeds** configuration type — manage log-ingestion connectors as code.
  Identity is the display name (the feed id is a server UUID); the source config
  is one validated `details` JSON blob (feedSourceType + logType + a `<source>Settings`
  object). Per-source secrets are write-only: sent on every deploy, never read
  back, excluded from drift and not restored on rollback (only the name is).
  Created/updated/deleted; app-created feeds are deleted on reconcile.
- **Forwarders** configuration type — manage on-prem collector-agent configs as
  code. Identity is the display name; the agent settings are one validated
  `config` JSON blob. Created/updated/deleted; forwarder config round-trips so
  rollback restores it in full.
- **Forwarder Collectors** configuration type — manage per-forwarder input
  sources as code. A nested child: the parent forwarder is resolved by display
  name (declare it with the Forwarders type first), then collectors are matched
  within it. Source config is a validated JSON blob; per-source secrets are
  write-only (excluded from drift, not restored on rollback). Created/updated/deleted.
- **Watchlists** configuration type — manage entity watchlists (a named entity
  group whose risk score is boosted by a multiplying factor) as code. Identity is
  the display name; created/updated/deleted (force). Entity membership is out of
  scope (populated out-of-band).
- **Findings Refinements** configuration type — manage detection exclusions as
  code. Identity is the display name; created/updated. NO delete endpoint — a
  removed refinement's deployment is disabled + archived instead; rollback
  disables created ones and restores updated ones (same no-delete family as
  reference lists).
- **Curated Rule Set Deployments** configuration type — manage the enabled /
  alerting state of Google-curated rule sets as code. Identity is category + rule
  set + precision (broad / precise). State-only reconcile via PATCH — Google owns
  the content, so nothing is created or deleted and unowned deployments are left
  untouched; rollback restores prior state (analogous to Rule Deployments).
- **Custom Parsers** configuration type — manage per-log-type custom parsers as
  code. Parsers are immutable + versioned: deploy content-hashes the desired code
  (base64-encoded as `cbn`) against the active parser and, when it differs,
  creates a new version and activates it, pruning the version it previously
  created. Identity is the log type; reconcile / rollback re-activate the prior
  parser and delete the created version.
- **Parser Extensions** configuration type — manage per-log-type CBN snippet
  extensions (which extend, not replace, the base parser) as code. Immutable:
  deploy content-hashes the snippet and, when it differs, creates and activates a
  new extension and deletes the previous app-created one. Identity is the log type.
- **Log Processing Pipelines** configuration type — manage ingest-time routing /
  transform pipelines as code. Identity is a client-set id (clean name key);
  displayName + description + a validated `processors` JSON array. Created/updated/
  deleted; app-created pipelines are deleted on reconcile.
- **BigQuery Export** configuration type — manage the instance-wide per-data-source
  export toggles (UDM Events / UDM Event Aggregates / Rule Detections / IoC Matches
  / Entity Graph: enable + retention) as code. A singleton — never created or
  deleted, only patched; rollback restores the prior settings (requires BigQuery
  export to be provisioned for the instance).

## 0.4.0 — 2026-07-26

### Added
- **Rule Deployments** configuration type — manage the deployment state of a
  detection rule as code: `enabled` (runs continuously against incoming data),
  `alerting` (detections treated as alerts) and `runFrequency` (LIVE / HOURLY /
  DAILY). Identity is the rule's `displayName` — the same identity the Detection
  Rules type uses; the rule must already exist. Deploy reuses that type's rule
  lister, resolves each declared rule (by stored ruleId, rename-safe, or display
  name), reads the `rules/{ruleId}/deployment` sub-resource and PATCHes it only
  when it differs. A deployment is a singleton (never created/deleted), so there
  is no reconcile-delete — a removed spec is left at its last-set state and
  rollback restores the prior state. Archived deployments are reported and left
  untouched. Rule TEXT stays the Detection Rules type's job.
- **Data Access Labels** configuration type — manage data access labels (named
  UDM-query tags applied to event data to gate visibility) as code. Labels are
  keyed by their immutable id (which is also the display name); only the UDM
  query and description are updatable. Deploy creates or PATCHes each label;
  reconcile deletes labels this app created but no longer declares; rollback
  deletes created labels or restores the prior definition.
- **Data Access Scopes** configuration type — manage data access scopes (boolean
  expressions of allowed/denied data access labels that restrict a permission
  group's data visibility) as code. Scopes are keyed by their immutable id;
  `allowAll` is mutually exclusive with an allowed-label list and fixed at
  creation (a differing live value is reported, not silently changed); only the
  description and allowed/denied label sets are updatable. Reconcile deletes
  app-created scopes; rollback deletes created scopes or restores prior state.

## 0.3.0 — 2026-07-26

### Added
- **Detection Rules** configuration type — manage SecOps (Chronicle) detection
  rules (YARA-L 2.0 rule source) as code, with the full pipeline handler set. A
  rule's identity is its name (the `rule <name> { ... }` header, which Chronicle
  echoes as `displayName`); validate parses it out of the text. Deploy lists live
  rules, matches each declared rule by the ruleId stored last deploy (rename-safe)
  or by display name, verifies the text with `rules:verifyRuleText` before writing,
  then creates a new rule or updates the matching one (a new revision) — a
  whitespace-normalized comparison avoids re-writing on cosmetic reformatting.
  Rules this app created but no longer declares are deleted (`force=true`), and
  rollback deletes created rules or restores prior text. This manages rule TEXT
  only; a rule's DEPLOYMENT state (live/alerting enablement) is out of scope.

## 0.2.0 — 2026-07-26

### Added
- **Data Tables** configuration type — manage SecOps data tables (named, typed
  columnar tables of rows) as code, with the full pipeline handler set. Tables
  are keyed by their immutable data-table id; the column schema is fixed at
  creation (a same-name table with a different schema is not modified); rows are
  reconciled to exactly the declared set with a single atomic `bulkReplace`;
  data tables (unlike reference lists) support delete, so reconcile deletes
  tables this app created (with `force=true`).
- `DELETE` support in the SecOps API client.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Google Security Operations (Chronicle) REST API client
  (`lib/googlesecops.ts`) with service-account auth — a JWT signed RS256 with the
  key's private key (via Node's built-in crypto, no extra dependency) is exchanged
  for a Bearer token that is cached and refreshed; regionalized API host + the
  projects/locations/instances resource parent.
- **Reference Lists** configuration type — manage SecOps reference lists (named
  string / regex / CIDR entry sets) as code, with the full pipeline handler set:
  validate, deploy, rollback, drift detection, health check and status. Lists are
  keyed by their immutable reference list id; entries are reconciled to exactly
  the declared set (a full-replace PATCH); the syntax type is fixed at creation.
  Reference lists cannot be deleted, so reconcile empties the ones this app
  created but no longer declares, and rollback restores prior entries (or empties
  a created list).
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the service-account-key credential and the `google-secops`
  deploy target.
- Connection test (`handlers/testConnection.ts`) minting a token and listing
  reference lists.
