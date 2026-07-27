# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

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
