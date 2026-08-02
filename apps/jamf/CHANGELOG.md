# Changelog

All notable changes to the Jamf app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
