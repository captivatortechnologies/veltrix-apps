# Changelog

All notable changes to the Jamf app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
