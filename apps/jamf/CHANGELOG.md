# Changelog

All notable changes to the Jamf app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-04

### Added — exhausting the config-as-code write surface

Seven new configuration types, closing out (with documented exclusions —
see README § Coverage) the writable Jamf Pro config-as-code surface across
both the modern Jamf Pro API and the legacy Classic (XML) API.

**Modern Jamf Pro API:**
- **Departments (`departments`).** Name-only records via
  `GET/POST/PUT/DELETE /v1/departments`, reconciled by name. `group: "Inventory"`.
- **Buildings (`buildings`).** Name plus a postal address via
  `GET/POST/PUT/DELETE /v1/buildings`, reconciled by name. `group: "Inventory"`.
- **Computer Extension Attributes (`computer-extension-attributes`).**
  Data type, input type (Script/Text/Pop-up Menu/Directory Service Attribute
  Mapping) and its input-specific fields (script contents, pop-up choices,
  LDAP mapping) via `GET/POST/PUT/DELETE /v1/computer-extension-attributes`,
  reconciled by name. **Research deviation, called out explicitly**: the
  wave brief suggested the Classic API for this resource, but that
  endpoint's own docs state the Jamf Pro API "offers full parity for this
  resource — we recommend using the Jamf Pro API for new integrations", so
  this config type uses the modern API instead — matching Jamf's own
  guidance rather than the Classic path the rest of this wave uses.
  `group: "Content"`.
- **Packages (`packages`).** Package METADATA records — packageName,
  fileName, category (declared by name, resolved to `categoryId` via this
  app's own Categories listing — the same by-name resolution pattern
  `policies` uses), priority and every installation-behavior flag
  (fillUserTemplate, rebootRequired, osInstall, suppressUpdates,
  suppressFromDock, suppressEula, suppressRegistration, ignoreConflicts,
  installLanguage) via `GET/POST/PUT/DELETE /v1/packages`, reconciled by
  package name. Binary upload is a separate, unlisted endpoint this app
  never calls — deploying a package record without first uploading the
  matching `.pkg`/`.dmg` in Jamf Pro creates a reference a policy can point
  to, but nothing installs. `group: "Content"`.

**Legacy Classic API (XML)** — reusing `lib/jamfApi.ts`'s `classicRequest`
(Bearer-first, Basic-auth fallback) and `lib/jamfClassicXml.ts`'s
merge-not-replace helpers, same as `policies` in 0.2.0:
- **Static Computer Groups (`static-computer-groups`).** Shares the Classic
  `/JSSResource/computergroups` resource with Smart Computer Groups but with
  `is_smart=false` and an explicit membership list. Membership is declared
  by **serial number** (stable, human-readable off the physical device) and
  resolved to a live computer id via the Classic
  `GET /computers/serialnumber/{sn}` lookup — flagged as deprecated
  (2025-02-11, in favor of `GET /api/v3/computers-inventory`) but still
  functional. Reconciled by name against existing STATIC groups only, so a
  same-named smart group is never mistaken for a match. Rollback restores
  the exact prior XML byte-for-byte. `group: "Scoping"`.
- **Restricted Software (`restricted-software`).** The process to detect,
  its notify/kill/delete response, and computer-group scope, via
  `/JSSResource/restrictedsoftware` (`<restricted_software><general>…
  </general><scope>…</scope></restricted_software>` — verified: the LIST
  endpoint's item tag is `<restricted_software_title>`, NOT
  `<restricted_software>`, the one Classic list in this app whose item tag
  differs from its detail root). No modern Jamf Pro API equivalent was
  found. Reconciled by name; an update merges only the managed general+scope
  fields into the record's existing XML. `group: "Policies"`.
- **macOS Configuration Profiles (`macos-configuration-profiles`).** Name,
  description, distribution method, removability, level and computer-group
  scope, via `/JSSResource/osxconfigurationprofiles`. **The embedded
  `.mobileconfig` plist payload (`general.payloads`) is treated as an opaque
  verbatim passthrough string** — escaped/unescaped as XML text content the
  same way as every other leaf, never parsed, generated, or validated as a
  plist; getting its internal payload UUIDs/types right is entirely the
  operator's responsibility. This is a deliberate, documented scope
  boundary (see README § Coverage), not an oversight. An update merges only
  the managed fields into the profile's existing XML, leaving Self Service
  branding, category, site, uuid and `redeploy_on_update` untouched. A
  dedicated test verifies the plist's own `<`/`>` characters survive
  XML-escaping without corrupting the outer document. `group: "Content"`.

### Changed
- `scripts` now also carries `group: "Content"` in the sidebar alongside the
  new types' groups (`Content` / `Inventory` / `Scoping` / `Policies`).
- `lib/jamfApi.ts`: `JamfClient.listAll` takes an optional `sortField`
  parameter (default `'name'`) so a resource that sorts by a different
  property (e.g. Packages' `packageName`) doesn't need its own list helper.

### Added — documentation
- **README § Coverage**: an explicit inventory of every Jamf Pro
  config-as-code surface this app manages, and every surface intentionally
  EXCLUDED and why (managed device/inventory data is enrollment/agent-owned,
  not admin-declared config; commands, redeploys, recalculations and exports
  are runtime actions, not declarative state; API clients/tokens and
  enrollment/LDAP credentials are credential administration, not config;
  Sites and Network Segments are read-only on every API surface checked;
  PreStage Enrollments and mobile-device profiles are out of scope for this
  wave, sized for a dedicated future one) — drop-don't-fake, not silently
  omitted.

## 0.2.0 — 2026-08-02

### Added
- **Categories (`categories`).** Manage Jamf Pro categories — name and Self
  Service ordering priority — as code through the modern Jamf Pro API
  (`GET/POST/PUT/DELETE /v1/categories`), reconciled by category name. Same
  create/update/rollback/drift shape as Scripts. `group: "Content"`.
- **Smart Computer Groups (`smart-computer-groups`).** Manage Jamf Pro smart
  computer groups — name and criteria — as code through the **legacy Classic
  API** (XML, `/JSSResource/computergroups`, since the modern API exposes only
  a read-only mirror for this resource), reconciled by group name. Criteria
  are declared as JSON (freeform criterion name/search-type — Jamf Pro's own
  UI derives valid search types from the chosen inventory attribute; there is
  no API to look that mapping up generically, so an invalid combination
  surfaces as a deploy-time error from Jamf Pro itself). Rollback restores the
  exact prior group XML byte-for-byte. `group: "Scoping"`.
- **Policies (`policies`).** Manage Jamf Pro policies — name, enabled state,
  the six trigger booleans, frequency, computer-group scope (by name),
  scripts (by name) and packages (by name) — as code through the **legacy
  Classic API** (XML, `/JSSResource/policies`). Every other policy section
  (Self Service, maintenance, disk encryption, printers, dock items, user
  interaction, …) is deliberately **out of scope and never touched**: an
  update fetches the policy's current full XML and merges only the managed
  sections into it, rather than replacing the whole document, so admin
  configuration made through the Jamf Pro UI is never silently wiped. A
  referenced computer group / script / package name that does not resolve to
  a live object fails that policy's deploy with a clear error. Rollback
  restores the exact prior full policy XML byte-for-byte. `group: "Policies"`.
- **Classic API (XML) support** (`lib/jamfApi.ts`, `lib/jamfClassicXml.ts`):
  `JamfClient.classicRequest` reuses the same cached Bearer token as the
  modern API (Jamf Pro's own docs: the token "functions as a Bearer token for
  all other Jamf Pro API endpoints"; Jamf Pro 10.35+ documents Bearer support
  for the Classic API specifically), falling back to HTTP Basic auth on a
  `401` since a handful of individual Classic reference pages still list only
  Basic per operation. `lib/jamfClassicXml.ts` hand-rolls a minimal,
  dependency-free XML parser/serializer scoped to the fixed Classic schemas
  this app reads and writes (no npm dependency available).
- `scripts` now carries `group: "Content"` alongside the three new types'
  groups (`Content` / `Scoping` / `Policies`) in the Configuration sidebar.

### Scope
- Configuration Profiles remain out of scope — a materially larger Classic
  API surface (payload-encoded `.mobileconfig` XML), planned for a future
  wave.
- The Classic API's Bearer-token support is well-documented at the product
  level but not independently re-verified against every individual endpoint's
  published OpenAPI metadata this session (see README § Classic API (XML)
  handling) — `classicRequest`'s Basic-auth fallback makes this a resilience
  detail rather than a correctness risk.

## 0.1.0 — 2026-08-02

### Added
- **Scripts (`scripts`).** Manage Jamf Pro scripts — name, priority
  (Before/After/At Reboot), category, OS requirements, positional parameter
  labels ($4–$11) and the script contents itself — as code through the modern
  Jamf Pro API (`GET/POST/PUT/DELETE /v1/scripts`), reconciled by script name.
  Missing scripts are created; existing scripts are updated to the declared
  spec. Rollback deletes created scripts and restores the full prior state
  (every managed field) of updated scripts. Drift detection treats a missing
  script or a changed `scriptContents` as critical, and any other metadata
  change as a warning.
- **Jamf Pro API client** (`lib/jamfApi.ts`): Basic-auth-for-a-bearer-token
  (`POST /v1/auth/token`), token caching keyed off the response's own
  `expires` timestamp, a single retry on `401` (re-acquire + retry once) and
  on `429` (defensive backoff — Jamf Pro does not document a rate limit), and
  a paged list helper for `/v1/<resource>` search endpoints.
- **Connectivity test**: obtains a Bearer token then calls
  `GET /v1/scripts?page-size=1` to verify the endpoint, credential, and the
  account's "Read Scripts" privilege.
- Ships the full handler set (validate, deploy, rollback, healthCheck,
  driftDetect, getStatus), an Overview / Setup Guide / Connections UI, and a
  `jamf-pro-server` component type.

### Scope
- This first release intentionally covers only the modern, self-contained
  JSON API surface (Scripts). Policies, Smart Groups and Configuration
  Profiles are served by the legacy Classic (XML) API and are planned for a
  follow-up release.
