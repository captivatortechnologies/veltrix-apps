# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.5.0 — 2026-07-26

### Added
- **Saved Searches** configuration type — manage saved RQL searches (name, query,
  searchType, cloudType, time range) as code. Searches are id-addressed with a
  client-supplied UUID stored for stability; the name is unique and immutable, so
  they are matched by name. Saved searches are the dependency for Config/IAM/
  Network/Audit custom policies. Reconcile only deletes searches this app created.
- **Custom Policies** configuration type — manage custom security policies (name,
  policyType, cloudType, severity, enabled, labels and a rule with type +
  saved-search criteria) as code. Matched by name (the policyId is stored for
  rename-safety); built-in systemDefault policies are protected; POST returns no
  body so the app re-lists by name to resolve the policyId; reconcile only deletes
  custom policies this app created.
- **Alert Rules** configuration type — manage alert rules / scan configs (name,
  policy selection via scanAll or policies/labels, target scope of account groups/
  regions/tags, and per-state notification flags, with an optional
  alertRuleNotificationConfig blob) as code. Matched by name (the
  policyScanConfigId is stored for rename-safety); create returns no body so the
  app re-lists by name; reconcile only deletes rules this app created.
- **Login IP Allow Lists** configuration type — manage trusted login IP allow
  lists (name, 1–10 CIDR blocks, description) as code. Matched by name (the id is
  stored for rename-safety); the enable/disable status toggle is intentionally out
  of scope; reconcile only deletes lists this app created.
- **Permission Groups** configuration type — manage custom permission groups
  (name, accepted scopes, feature grants) as code. Only Custom groups are managed;
  Default and Internal groups are protected. Matched by name (the id is stored for
  rename-safety); reconcile only deletes groups this app created.
- **Collections** configuration type — manage collections (name, description and
  asset scoping by account groups, cloud accounts and code repositories) as code.
  Matched by name (the id is stored for rename-safety); reconcile only deletes
  collections this app created.
- **Anomaly Trusted Lists** configuration type — manage anomaly trusted lists
  (name, trustedListType, applicable anomaly policies and typed entries that
  suppress anomaly alerts) as code. Matched by name (the id is stored for
  rename-safety); reconcile only deletes lists this app created.
- **Trusted Alert IPs** configuration type — manage trusted alert IPs (name and
  CIDR entries) excluded from network anomaly alerting, as code. Distinct from the
  login IP allow list. Matched by name (the uuid is stored for rename-safety);
  reconcile only deletes lists this app created.
- **Notification Templates** configuration type — manage notification templates
  (name, integrationType of email/jira/service_now, integrationId and a validated
  templateConfig blob) as code. jira/service_now templates reference an
  Integration. Matched by name (the id is stored for rename-safety); reconcile
  only deletes templates this app created.
- **Reports** configuration type — manage scheduled report definitions (name,
  reportType, cloudType and a validated target/schedule blob) as code. Manages the
  report definition/schedule, never the generated artifact. Matched by name (the
  id is stored for rename-safety); reconcile only deletes reports this app created.
- **Enterprise Settings** configuration type — manage tenant-wide enterprise
  settings (session timeout, access-key validity, notification and default-policy
  options) as a singleton via GET-merge-PUT of only the declared fields (blanks
  leave live values untouched; boolean fields are tri-state). Rollback restores the
  full pre-deploy snapshot; there is no create/delete.

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
