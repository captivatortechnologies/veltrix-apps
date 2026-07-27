# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.4.0 — 2026-07-26

### Added
- **Compliance Sections** configuration type — manage custom compliance sections
  under a custom requirement as code, completing the standard → requirement →
  section tree. Each section resolves its parent standard by name then its parent
  requirement by `requirementId`, and is matched by `sectionId` within the
  requirement (the id is stored for rename-safety) and reconciled
  (description/viewOrder). Built-in standards, requirements and sections are
  protected; reconcile only deletes sections this app created.
- **Roles** configuration type — manage Prisma Cloud user roles (name, roleType,
  account groups, resource lists, restrict-dismissal) as code. `roleType` may be a
  built-in role type or a custom permission group name. Roles are matched by name
  (the id is stored for rename-safety) and reconciled; reconcile only deletes
  roles this app created.
- **Resource Lists** configuration type — manage Prisma Cloud resource lists
  (name, resourceListType of TAG / RESOURCE_GROUP / COMPUTE_ACCESS_GROUP, and
  members as a JSON array) as code. Lists are matched by name (the id is stored
  for rename-safety) and reconciled; reconcile only deletes lists this app
  created.

## 0.3.0 — 2026-07-26

### Added
- **Compliance Requirements** configuration type — manage custom compliance
  requirements under a custom compliance standard as code, with the full pipeline
  handler set. Each requirement declares its parent standard by name (resolved to
  a complianceId at deploy — the standard must already exist); requirements are
  matched by `requirementId` within the standard (the id is stored for rename-
  safety) and reconciled (name/description/viewOrder). Built-in standards are
  protected; reconcile only deletes requirements this app created.

## 0.2.0 — 2026-07-26

### Added
- **Account Groups** configuration type — manage Prisma Cloud account groups
  (name, description, and member cloud-account ids) as code, with the full
  pipeline handler set. Groups are matched by name (Prisma has no lookup-by-name)
  with the id stored for rename-safety; create returns the id; auto-created
  groups are protected; reconcile only deletes groups this app created (Prisma
  blocks deleting a group still referenced by a cloud account or alert rule).

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
