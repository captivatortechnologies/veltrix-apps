# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.5.0 — 2026-07-26

### Added
- **Address Alteration Sets** configuration type — manage the reusable folders
  that address alteration policies reference (`/api/policy/address-alteration/
  create-address-alteration-set` + `get-address-alteration-set`). Sets are keyed
  by description under an optional parent. Mimecast exposes no delete- or
  update-set API, so this is an ensure-exists type: it creates a declared set if
  it is missing and never prunes or renames one (a re-deploy is a no-op).
- **Address Alteration Definitions** configuration type — manage the rewrite
  rules inside a set (`create-definition` / `get-definition` / `delete-definition`).
  A definition has no name and no update API, so its identity is the full rule
  tuple (folder, routing, address type, original → new address); a change is a new
  rule and reconcile deletes only the definitions this app created.
- **Directory Profile Groups** configuration type — manage cloud groups of email
  addresses and domains with membership (`find-groups` / `create-group` /
  `delete-group` and `get/add/remove-group-member`). Groups are matched by name
  under an optional parent; the app adds declared members and removes only members
  it added; LDAP-synced groups are managed read-only and skipped; reconcile empties
  and deletes only groups this app created.
- **Web Security Policies** configuration type — manage Secure Web Gateway
  block/allow policies (`/api/policy/webwhiteurl/create-policy-with-targets`,
  `get-policies`, `delete-policy`). Policies are matched by description and carry a
  URL block/allow list plus a sender/recipient scope; a change is applied as delete
  + recreate, the prior policy is carried forward so rollback can restore it, and
  reconcile only deletes policies this app created. Distinct from the TTP URL
  Protect managed URLs (`/api/ttp/url/`).

## 0.4.0 — 2026-07-26

### Added
- **Address Alteration** configuration type — manage Mimecast address alteration
  policies (apply an address alteration set to scoped senders/recipients) as code,
  with the full pipeline handler set. Each policy binds an existing Address
  Alteration Set (referenced by its secure `addressAlterationSetId`) to a
  sender/recipient scope; policies are matched by description; from/to targeting is
  kept self-contained (everyone / email domain / email address); `fromPart`
  (envelope/header/both) and `enabled` are configurable; a change is applied as
  delete + recreate; the prior policy is carried forward so rollback can restore
  it; reconcile only deletes policies this app created.

## 0.3.0 — 2026-07-26

### Added
- **Anti-Spoofing Bypass** configuration type — manage Mimecast anti-spoofing
  bypass policies (bypass anti-spoofing checks for trusted senders) as code, with
  the full pipeline handler set. Policies are matched by description; from/to
  targeting is kept self-contained (everyone / email domain / email address); the
  bypass can be scoped to a list of SPF domains (`conditions.spfDomains`); a change
  is applied as delete + recreate; the prior policy is carried forward so rollback
  can restore it; reconcile only deletes policies this app created.

## 0.2.0 — 2026-07-26

### Added
- **Blocked Senders** configuration type — manage Mimecast blocked sender
  policies (block a sender email/domain from reaching recipients) as code, with
  the full pipeline handler set. Policies are matched by description; from/to
  targeting is kept self-contained (everyone / email domain / email address); a
  change is applied as delete + recreate; the prior policy is carried forward so
  rollback can restore it; reconcile only deletes policies this app created.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Mimecast API 2.0 client (`lib/mimecast.ts`) with OAuth2
  client-credentials auth (token cache + refresh), the `{ data: [...] }` request
  wrapper, `{ meta, data, fail }` response handling (HTTP 200 + non-empty `fail`
  is treated as a failure), and 429 `X-RateLimit-Reset` backoff.
- **Managed URLs** configuration type — manage Targeted Threat Protection managed
  URLs (permit/block by exact URL or domain) as code, with the full pipeline
  handler set: validate, deploy, rollback, drift detection, health check and
  status. Managed URLs have no update API, so entries are matched by their URL
  identity (match type + normalized url/domain) and a change is applied as delete
  + recreate; the original pre-management entry is carried forward so rollback can
  restore it, and reconcile only deletes entries this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the client-id + secret credential and the `mimecast` deploy
  target.
- Connection test (`handlers/testConnection.ts`) acquiring a token and listing
  managed URLs.
