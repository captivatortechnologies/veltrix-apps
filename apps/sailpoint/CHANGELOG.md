# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.6.0 — 2026-08-05

### Added
- **Entitlements** configuration type — governance-metadata overlay on
  SailPoint ISC entitlements (`/beta/entitlements`): owner, requestable,
  privileged, description and segment assignments, plus the aggregation locks
  that protect a declared name/description from being overwritten by a later
  source aggregation. Entitlements are discovered by source aggregation, never
  created or deleted through the API, so this type only ever patches an
  already-existing entitlement — matched within a Source (resolved by name) by
  the entitlement's own name, optionally disambiguated by its schema attribute,
  with the id cached after the first match for rename-safety. Reconcile
  reverts the overlay on an undeclared item rather than deleting anything, the
  same non-destructive pattern used by MFA Configuration and Tenant
  Configuration. Takes the app to 31 managed ISC configuration types.

### Documentation
- Added a README **Coverage** section: the full grouped list of what this app
  manages, versus what's intentionally out of scope (one-shot
  campaign/certification runs, read-only reference data, secret material that
  can't round-trip, and per-user non-employee records) with a one-line reason
  for each. The README previously only documented the original Transforms
  release and had not been updated across the twenty-four-type wave 0.5.0
  shipped.

## 0.5.0 — 2026-07-26

### Added

Twenty-four new configuration types, each with the full pipeline handler set
(validate, deploy, rollback, drift detection, health check, status), taking the
app from six to thirty managed ISC configuration types. All new id-addressed
types are matched by name with the id stored for rename-safety, and reconcile
only deletes objects this app created.

Connectivity & sources:
- **Sources** (`/v3/sources`) — connector instances; JSON-Patch scalar updates;
  connector attributes are a secret-bearing JSON blob (applied on deploy, not
  drift-tracked).
- **Source Schemas** (`/v3/sources/{id}/schemas`) — nested under a source, keyed
  by schema name; full-replace PUT; reconcile within the parent source.
- **Provisioning Policies** (`/v3/sources/{id}/provisioning-policies`) — nested
  under a source, keyed by usageType enum; full-replace PUT per usageType.
- **Correlation Configs** (`/v3/correlation-config`) — account correlation
  attribute assignments; full-replace PUT.
- **Managed Clusters** (`/v3/managed-clusters`) — VA cluster records (the
  appliance still needs manual bootstrap); JSON-Patch updates.

Identity governance:
- **Identity Profiles** (`/v3/identity-profiles`) — authoritative-source-driven
  identity construction; JSON-Patch updates; authoritative source immutable.
- **Lifecycle States** (`/v3/identity-profiles/{id}/lifecycle-states`) — nested
  under an identity profile, keyed by technicalName; JSON-Patch updates.
- **Identity Attributes** (`/beta/identity-attributes`) — custom identity
  attributes, name-keyed; full-replace PUT; standard/system attributes protected.
- **Search Attributes** (`/v3/accounts/search-attribute-config`) — extended
  search attributes, name-keyed; POST create / JSON-Patch update.
- **Role Dimensions** (`/beta/roles/{id}/dimensions`) — nested under a role,
  keyed by dimension name; JSON-Patch updates.

Policy & compliance:
- **SOD Policies** (`/v3/sod-policies`) — separation-of-duties policies
  (GENERAL query or CONFLICTING_ACCESS_BASED criteria); full-replace PUT.
- **Password Sync Groups** (`/v3/password-sync-groups`) — full-replace PUT.
- **Campaign Templates** (`/v3/campaign-templates`) — certification campaign
  templates (not runs); JSON-Patch updates; embedded campaign is a normalized
  JSON blob; schedule out of scope.
- **MFA Configuration** (`/v3/mfa/{method}/config`) — Duo and Okta Verify
  per-method singletons; configProperties secret-bearing (applied on deploy, not
  drift-tracked); non-destructive revert of app-enabled methods.
- **Tenant Configuration** singletons — access-request-config,
  password-org-config, public-identities-config, org-config and the auth-org
  lockout/session/network/service-provider configs; read+replace with a prior
  snapshot, reverted on rollback or undeclare.

Automation & integration:
- **Workflows** (`/v3/workflows`) — created disabled then enabled; full-replace
  PUT; trigger/definition JSON blobs (drift on scalars only).
- **Trigger Subscriptions** (`/beta/trigger-subscriptions`) — HTTP and
  EventBridge event delivery; JSON-Patch updates; HTTP config secret-bearing
  (applied on deploy, not drift-tracked).
- **Connector Rules** (`/beta/connector-rules`) — BeanShell cloud rules;
  full-replace PUT; rule type immutable.
- **Service Desk Integrations** (`/v3/service-desk-integrations`) — connection
  attributes secret-bearing (applied on deploy, not drift-tracked).
- **SIM Integrations** (`/beta/sim-integrations`) — connection attributes
  secret-bearing (applied on deploy, not drift-tracked).
- **Notification Templates** (`/beta/notification-templates`) — composite-keyed
  by key+medium+locale; create replaces the override, reconcile bulk-deletes
  app-created triples.
- **Verified From-Addresses** (`/beta/verified-from-addresses`) — email-keyed;
  create/delete only; SES verification is out-of-band so drift reports pending.

Applications & non-employees:
- **Source Apps** (`/beta/source-apps`) — access-request applications;
  JSON-Patch updates; account source immutable.
- **Non-Employee Sources** (`/beta/non-employee-sources`) — the source
  container only (individual records are per-user and out of scope); JSON-Patch
  updates.

## 0.4.0 — 2026-07-26

### Added
- **Access Profiles** configuration type — manage ISC access profiles (name,
  owner, source, entitlement ids, enabled/requestable) as code, with the full
  pipeline handler set. Matched by name with the id stored for rename-safety;
  updates use JSON-Patch; the source is immutable so a same-name profile on a
  different source is rejected; an enabled profile must grant at least one
  entitlement; reconcile only deletes profiles this app created.
- **Roles** configuration type — manage ISC roles (name, owner, bundled access
  profile ids, enabled/requestable) as code, with the full pipeline handler set.
  Matched by name with the id stored for rename-safety; updates use JSON-Patch;
  role membership (auto-assignment) is managed separately in ISC and is out of
  scope; reconcile only deletes roles this app created.
- **Password Policies** configuration type — manage ISC password policies
  (length, composition, expiration and strength rules) as code, with the full
  pipeline handler set. Matched by name with the id stored for rename-safety; ISC
  updates via a full-replace PUT, so unmanaged fields (source assignments, the
  default flag) are preserved and only the rule fields are overridden; the tenant
  default policy is protected and never modified; reconcile only deletes policies
  this app created.

## 0.3.0 — 2026-07-26

### Added
- **Governance Groups** configuration type — manage ISC governance groups
  (workgroups: name, description, owner Identity) as code, with the full pipeline
  handler set. Groups are matched by name with the id stored for rename-safety;
  updates use JSON-Patch; each group requires an owner Identity id; membership is
  managed separately in ISC and is out of scope; reconcile only deletes groups
  this app created.

## 0.2.0 — 2026-07-26

### Added
- **Segments** configuration type — manage ISC segments (name, description,
  active) as code, with the full pipeline handler set. Segments are id-addressed
  with no lookup-by-name, so the app lists all and matches by name, storing the
  id for rename-safety; updates use JSON-Patch; reconcile only deletes segments
  this app created.

## 0.1.0 — 2026-07-26

### Added
- Initial release. SailPoint Identity Security Cloud (ISC) API client
  (`lib/isc.ts`) with OAuth2 client-credentials auth, token caching, offset/limit
  pagination and 429 retry.
- **Transforms** configuration type — manage ISC transforms (name, operation
  type, type-specific JSON attributes) as code, with the full pipeline handler
  set: validate, deploy, rollback, drift detection, health check and status.
  Transforms are matched by their immutable name; built-in (internal) transforms
  are protected and a same-name transform of a different type is never silently
  replaced.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the ISC client-credentials credential (Client ID + Client
  Secret) and the `sailpoint-tenant` deploy target.
- Connection test (`handlers/testConnection.ts`) verifying the OAuth token
  exchange + `GET /transforms/v1`.
