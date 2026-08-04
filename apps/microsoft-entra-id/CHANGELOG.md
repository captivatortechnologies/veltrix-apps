# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.8.2 — 2026-08-04

Live pickers Phase 2 (batch 1) — Roles / PIM / Directory. Reference fields on
these config types now search/select from the live tenant like Conditional Access:

- **directory-role-assignments** — role → live directory-role picker; principal →
  merged users/groups/service-principals picker; scope → tenant / administrative-unit
  / application picker.
- **pim-role-eligibility** — same role / principal / scope live pickers.
- **pim-role-management-policies** — role → live directory-role picker.
- **administrative-units** — members → merged users/groups/**devices** picker, with
  provenance-tracked membership (only removes members this app added; `/$ref` delete
  semantics handled so a member object is never deleted from the directory).
- New shared option sources: `devices`, `applicationObjects` (object-id, distinct
  from the appId-keyed `applications`); reusable `nameMaps`/`principals`/`directoryScope`
  resolver libs. All id-aware + backward compatible (hand-typed names still resolve).

## 0.8.1 — 2026-08-04

Conditional Access — full targeting surface as live pickers. Building on 0.8.0,
the policy form now searches/selects every target from the connected tenant:

- **Users** (Included/Excluded) → live users picker (sentinels `All` / `None` /
  `GuestsOrExternalUsers` on include; `GuestsOrExternalUsers` on exclude).
- **Directory Roles** (Included/Excluded) → live roleDefinitions picker (built-in
  roles; the roleDefinition id equals the role-template id CA expects).
- **Named Locations** (Included/Excluded) → live namedLocations picker (sentinels
  `All` / `AllTrusted` on include).
- **Authentication Strength** → single live picker → `grantControls.authenticationStrength`.
- **Terms of Use** → live agreements picker → `grantControls.termsOfUse` (note:
  the picker needs delegated Graph permission; writing a hand-typed agreement id
  works under app permissions — documented in the Setup Guide).
- Setup Guide updated with the extra Graph permissions the pickers require
  (`User.Read.All`, `RoleManagement.Read.Directory`). id-aware + backward
  compatible throughout (hand-typed names still resolve).

## 0.8.0 — 2026-08-04

Live remote pickers for reference fields — config forms now pull related objects
from the connected tenant instead of pasting display names / GUIDs.

- **Shared live-options provider** (`config-types/lib/entraOptions.ts`) — 12
  Graph-backed sources (groups, users, applications, servicePrincipals,
  namedLocations, roleDefinitions, administrativeUnits, authStrengthPolicies,
  termsOfUse, authContexts, accessPackageCatalogs, connectedOrganizations),
  searchable server-side (`$search` where supported) and id→label on mount.
- **Conditional Access Policies** — Included/Excluded Groups and Included Apps
  are now searchable live pickers (Groups picker; Applications picker with the
  All / Office365 / MicrosoftAdminPortals cloud-app sentinels).
- **id-aware, backward compatible** — pickers store ids/appIds; a hand-typed
  display name still resolves at deploy time.

Phase 1 of a rollout wiring the same live pickers into every reference field
across all Entra config types.

## 0.7.1 — 2026-08-02

Grouped the 42 configuration types in the Configurations sidebar into ten
sub-sections mirroring the Entra admin center, so the app is navigable instead
of one flat list.

- **Config sidebar groups** — each configuration type now declares a `group`:
  Conditional Access · Directory · Tokens & Claims · Roles & PIM ·
  Tenant Settings · Authentication Methods · Applications & Service Principals ·
  External Identities · Custom Security Attributes · Identity Governance.
  Organization-only — no change to any deploy/rollback/drift behavior.

## 0.7.0 — 2026-07-28

### Added
- **Six new configuration types** covering the identity objects that policies act upon:
  - **Directory Role Assignments** — active/permanent privileged role holders
    (`/roleManagement/directory/roleAssignments`; no PATCH → delete + recreate on change).
  - **PIM Role Eligibility** — eligible role assignments via
    `roleEligibilityScheduleRequests` (request-based; drift diffs derived schedules).
  - **App Registrations** — `/applications` (upsert by uniqueName; redirect URIs,
    app roles, required resource access).
  - **Service Principals** — `/servicePrincipals` (SSO, app role assignments).
  - **Terms of Use Agreements** — `/identityGovernance/termsOfUse/agreements`.
  - **Cross-Tenant Access Default** — the tenant-wide default policy singleton
    (completes the existing per-partner coverage).

## 0.6.0 — 2026-07-26

### Added

Twenty-two new configuration types across policy, directory, external identity,
identity-governance, branding and privileged-access surfaces of Microsoft Graph v1.0:

**Tenant policy singletons**
- **Tenant Authorization Policy** — default user/guest/consent controls
  (allowInvitesFrom, guest role, default user role permissions) via singleton PATCH.
- **Security Defaults** — the security defaults enforcement policy toggle.
- **Authentication Flows Policy** — the self-service sign-up toggle.
- **Admin Consent Request Policy** — admin consent workflow (reviewers, reminders,
  request duration) via a full-replace PUT.

**Policy collections (JSON `definition` / restrictions)**
- **Token Issuance Policies**, **Home Realm Discovery Policies** and
  **Activity-Based Timeout Policies** — managed via a JSON `definition` (canonicalized
  for idempotent drift), the latter two with organization-default handling.
- **App Management Policies** — credential (password / key) hygiene restrictions.
- **Feature Rollout Policies** — staged rollout of cloud MFA, seamless SSO,
  certificate-based auth, etc. (group targeting not managed).
- **Permission Grant Policies** — app-consent policies with their include / exclude
  condition sets reconciled as owned sets; built-in `microsoft-*` policies protected.
- **Cross-Tenant Access Partners** — per-partner B2B collaboration / direct connect /
  trust settings, keyed by tenant id.

**Authentication methods**
- **Authentication Methods** — per-method enablement (state) for FIDO2, Microsoft
  Authenticator, SMS, TAP, email, certificate, OATH and voice (fixed-id PATCH).

**Directory & external identity**
- **Group Settings** — tenant/group directory settings from groupSettingTemplates
  (guest owners, naming, classifications) via name/value pairs.
- **Custom Security Attribute Sets** and **Definitions** — attribute governance;
  sets are never deleted and definitions are deactivated (status Deprecated) rather
  than deleted.
- **External Identity Providers** — social IdPs (Google, Facebook, GitHub, …) for
  B2B guest sign-in; the client secret is write-only.
- **Delegated Permission Grants** — admin-consented OAuth2 scopes keyed by
  client + resource + consent type.
- **User Flow Attributes** — custom self-service sign-up profile fields.
- **Self-Service Sign-Up Flows** — b2xIdentityUserFlow (create/delete only).

**Identity governance (entitlement management & reviews)**
- **Access Package Catalogs** (built-in General protected), **Access Packages**
  (bound to a catalog) and **Assignment Policies** (targeting / approval / expiration).
- **Connected Organizations** — external partner directories/domains.
- **Access Review Definitions** — recurring membership reviews.
- **Lifecycle Workflows** — joiner / mover / leaver automation (requires Entra ID
  Governance).

**Branding & privileged access**
- **Organizational Branding** — the company branding default sign-in page text,
  colors and footer links, managed as a scalar-bounded singleton (locale "0")
  via PATCH with `Accept-Language: 0`; logos, background image, favicon and custom
  CSS are out of scope. Requires Entra ID P1/P2.
- **PIM Role Policies** — Privileged Identity Management activation requirements
  (MFA / justification / ticketing / approval / maximum duration) for Directory-scope
  roles. The policy is resolved from the role's assignment and the three end-user
  activation rules (enablement, expiration, approval) are patched in place; the
  approval toggle merges into the live setting so existing approval stages are
  preserved. Rules are never created or deleted.

### Changed
- `lib/graph.ts`: added a `put()` convenience helper and an optional per-call
  header override on `request()` (both used by the new PUT-based / localized types),
  leaving existing behavior unchanged.

## 0.5.0 — 2026-07-26

### Added
- **Administrative Units** configuration type — manage Entra administrative
  units (name, description, visibility) as code. Membership and scoped role
  assignments are not managed; reconcile only deletes units this app created.
- **Authentication Strengths** configuration type — manage custom Conditional
  Access authentication strengths (allowed authentication method combinations)
  as code. Built-in strengths are protected; combinations are changed via the
  Graph `updateAllowedCombinations` action.
- **Token Lifetime Policies** configuration type — manage access / ID token
  lifetimes as code via a JSON `definition` (validated as JSON) with optional
  organization-default activation.
- **Claims Mapping Policies** configuration type — manage token claims
  customization as code via a JSON `definition` (validated as JSON).
- **Custom Role Definitions** configuration type — manage custom directory roles
  (allowed resource actions, enabled state) as code. Built-in roles are
  protected. Requires Microsoft Entra ID P1/P2.
- **Authentication Contexts** configuration type — manage Conditional Access
  authentication context class references (c1..c25) as code via an id-keyed
  PATCH upsert; referenced by policies and issued in the acrs token claim.

## 0.4.0 — 2026-07-26

### Added
- **Client UI**: real Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`. Overview lists what the app manages (fetched from
  a new server `/meta` route); Setup Guide walks through the app registration,
  Graph application permissions + admin consent, credential mapping and tenant
  wiring; Connections uses the shared `<ConnectionsManager>` configured for the
  app-registration credential (Application (client) ID + client secret) and the
  `entra-tenant` deploy target.
- Server `/meta` and `/settings` routes.

### Changed
- Replaced the template placeholder logo with an original Entra-branded mark
  (blue/cyan). Removed the remaining template placeholder client pages.

## 0.3.0 — 2026-07-26

### Added
- **Conditional Access Policies** configuration type — the flagship. Manage CA
  policies as code with the full pipeline handler set: user/group and cloud-app
  targeting, grant controls (MFA, compliant device, block, …) with an OR/AND
  operator. Groups are referenced by display name and resolved to ids at deploy
  time, composing with the Security Groups type. New policies default to
  **report-only** (never enforced on creation); validate enforces block
  exclusivity and warns when an enforced policy has no break-glass exclusion.

## 0.2.0 — 2026-07-26

### Added
- **Security Groups** configuration type — manage Entra assigned security groups
  (display name, description, mail nickname) as code, with the full pipeline
  handler set. Mail-enabled, Microsoft 365 (Unified) and dynamic-membership
  groups are protected: deploy refuses to modify a live name-match that is not a
  plain assigned security group, and reconcile only deletes groups this app
  created. Mail nicknames are derived from the display name when left blank.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Microsoft Graph API client (`lib/graph.ts`) with OAuth2
  client-credentials auth, token caching, `@odata.nextLink` pagination and 429
  retry.
- **Named Locations** configuration type — manage Conditional Access named
  locations (IP CIDR ranges and country/region lists) as code, with the full
  pipeline handler set: validate, deploy, rollback, drift detection, health
  check and status.
- Connection test (`handlers/testConnection.ts`) that verifies the
  app-registration credential end to end via `GET /organization`.
