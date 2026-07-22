# Changelog

All notable changes to the Okta app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.9.0 — 2026-07-22

### Added
- **Users config type (safe-by-design).** Manage a CONTROLLED set of Okta users
  as code — break-glass admins, service/bot accounts, sandbox seed users — via
  the Users API. Deliberately NOT for general workforce management (that belongs
  to HR/SCIM provisioning). Guarantees:
  - Only users declared in the canvas are managed (matched by stored id, then by
    login); a user NOT in the canvas is never read or written.
  - Users are **never deleted** — the strongest action is deactivate
    (DEPROVISIONED), and only when an item's Status is set to Deactivated.
  - Per user: create (STAGED), update profile, and reconcile lifecycle toward the
    desired status (activate / unsuspend / suspend / deactivate). Login is the
    identity (rename-safe). Full validate/deploy/rollback/health/drift handlers;
    rollback deactivates created users rather than deleting them.

## 1.8.7 — 2026-07-21

### Added
- **Validate-time warning for a group-rule expression that isn't a Boolean.** A
  rule condition must resolve to true/false; an expression that only builds a
  string (concatenation / `toUpperCase`/`substring…` with no comparison or logical
  operator) now raises a warning at Validate — e.g. *"looks like it builds a string
  rather than a true/false condition"* — instead of only failing later at deploy
  when Okta type-checks it. Conservative: any comparison, `AND`/`OR`, or
  boolean-returning function (`stringContains`, `isMemberOfGroupName`, …) suppresses
  it, so valid conditions never trip the warning.

## 1.8.6 — 2026-07-21

### Changed
- **Live pickers for the three polymorphic/sentinel reference fields.** These
  needed custom sources rather than a plain object list:
  - auth-server-policies **Included Clients** (`clientInclude`) — a multi-select
    that offers the `ALL_CLIENTS` sentinel (the field default) plus the org's apps.
  - profile-mappings **Source** / **Target** — a single-select over the merged
    UserType + app-instance id spaces (labelled by kind, since either is valid).
  - resource-set-bindings **Role** — a single-select over the org's custom admin
    roles (`cr0…`) plus the standard admin role types (fixed enums).
  Adds `oauthClients`, `mappingEndpoints`, and `roles` sources to the shared
  options provider and the options handler to the Profile Mappings type. Value
  shapes unchanged, so existing configs keep working.

## 1.8.5 — 2026-07-21

### Changed
- **Live pickers for single-value object references.** Ten id fields that were
  free-text are now searchable `remote-select` pickers over the connected org's
  live objects (name shown, id stored): app-group-assignments Application & Group;
  Authorization Server on auth-server claims/policies/scopes; Email Domains' Brand;
  Brands' Email Domain; Apps' Access Policy; Profile Schemas' User Type; Resource
  Set Bindings' Resource Set. Value shape unchanged (a single id string), so
  existing configs keep working.

## 1.8.4 — 2026-07-21

### Changed
- **Live Members picker for a Group.** A group's *Members* field (`memberUserIds`)
  is now a searchable multi-select over the connected org's users (name + email
  shown, user id stored) instead of a free-text id box. Adds a `users` source to
  the shared options provider and the `options` handler to the Groups config type.
- **Live Zones picker for ThreatInsight exemptions.** *Exempt Network Zones*
  (`excludeZones`) is now a searchable multi-select over the org's Network Zones
  (name shown, id stored). Adds a `zones` source + the `options` handler to the
  ThreatInsight config type.

Both store the same value shape as before (an array of ids), so existing configs
keep working.

## 1.8.3 — 2026-07-21

### Changed
- **Live Groups picker for a Group Rule's target groups.** The rule's *Target
  Groups* field (`groupIds`) is now a searchable multi-select backed by the
  connected org's live OKTA_GROUP groups (name shown, id stored) — the same
  picker used for a policy's Scoped Groups — instead of a free-text "type a group
  id and press Enter" box. Adds the shared `options` handler to the Group Rules
  config type; the stored value shape (an array of group ids) is unchanged, so
  existing rules keep working.

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
