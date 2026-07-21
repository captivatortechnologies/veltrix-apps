# Changelog

All notable changes to the Okta app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.8.2 — 2026-07-21

### Fixed
- **A stale group id no longer fails the whole Groups deploy.** When a group's
  stored Okta id resolved on read but was not live for member operations (a
  deleted/duplicate id, or one still settling in Okta), membership listing
  returned `404 Resource not found (UserGroup)` and aborted the entire batch
  ("0 of N groups"). Membership now treats that 404 as "group not readable":
  the group's profile still deploys, membership is skipped for just that group
  with a warning in the result, and the stale id is dropped so the next deploy
  re-matches the item to a live group by name. Drift-detection and rollback
  tolerate the same 404 instead of throwing.

## 1.8.1 — 2026-07-21

### Changed
- **Rename-safe policy identity.** Policy deploy now records each policy's Okta id
  per canvas item and matches by that stored id (verifying the immutable policy
  type) on the next deploy — so renaming a policy's **Name** updates the *same*
  Okta policy in place instead of creating a duplicate. Falls back to (type, name)
  matching for the first deploy. Completes the rename-safe identity started for
  groups in 1.8.0.

## 1.8.0 — 2026-07-21

### Added
- **Live group picker** for a policy's *Scoped Groups* (`groupIncludeIds`). The
  field now lists the connected org's real OKTA_GROUP groups (name shown, id
  stored) with type-to-search, instead of free-text group ids — so you can't
  reference a group that doesn't exist. Powered by a new generic options
  provider (`config-types/lib/oktaOptions`) run server-side against the
  connection. Requires app-sdk ≥ 3.4.0.
- **Live pre-validation of scoped group ids.** Validate now verifies each
  referenced policy group id exists in the target Okta org and fails cleanly
  ("group … not found") *before* a deploy, instead of surfacing the 404
  mid-deploy. Best-effort — validate stays static-only when no connection is
  registered.

### Changed
- **Rename-safe group identity.** Group deploy now records each group's Okta id
  per canvas item and matches by that stored id on the next deploy — so renaming
  a group's **Name** updates the *same* Okta group in place instead of creating
  a duplicate and orphaning the old one. Falls back to name matching for the
  first deploy or when a stored id no longer resolves.

## 1.7.1 — 2026-07-20

### Fixed
- Saving a Connection now also registers its **deploy target** (an `okta-org`
  component whose hostname is the connection's endpoint, linked to the
  credential and environment). Previously a connection created only a credential,
  so Deploy stayed disabled ("register an okta-org connection to deploy") even
  though the connection tested green. Re-saving an existing connection back-fills
  its target. Requires app-sdk ≥ 3.3.0.

## 1.7.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 10 collapsible sections — Policies
  & Rules, Authentication, Directory, Applications, Authorization Servers,
  Network & Security, IAM Governance, Profile & Schema, Integrations, and
  Branding & Notifications — so all 32 configuration types stay navigable.
  Sections collapse by default, remember whether you left them open, and always
  expand the one you're currently working in.
