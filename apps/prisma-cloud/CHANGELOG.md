# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.1.0 — 2026-07-26

### Added
- Initial release. Prisma Cloud CSPM API client (`lib/prismacloud.ts`) with
  access-key login (`POST /login` → JWT), the `x-redlock-auth` header, automatic
  re-login on 401, and `x-redlock-status` error-key parsing.
- **Compliance Standards** configuration type — manage Prisma Cloud custom
  compliance standards (name + description) as code, with the full pipeline
  handler set: validate, deploy, rollback, drift detection, health check and
  status. Standards are matched by name (Prisma has no lookup-by-name and
  enforces name uniqueness); built-in (system default) standards are protected;
  create returns no id so the app re-fetches to resolve it; reconcile only
  deletes standards this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the access-key credential and the `prisma-cloud` deploy target.
- Connection test (`handlers/testConnection.ts`) logging in and calling
  `GET /compliance`.
