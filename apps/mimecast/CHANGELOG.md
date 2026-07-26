# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

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
