# Changelog

All notable changes to the Sumo Logic app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and semver.

## 0.3.0 — 2026-08-04

Twelve new configuration types, each a full Security-as-Code pipeline
(validate, deploy, rollback, health check, drift detection and status) over
the Sumo Logic Management API — researched against the official OpenAPI
specification (`api.sumologic.com/docs/sumologic-api.yaml`) and the SumoLogic
Terraform provider. New sidebar groups: **Alerting & Notifications** and
**Content Library**, alongside the existing Parsing / Data Management / Access
Control groups.

- **Monitors** (`/api/v1/monitors`) — alert definitions (query, trigger
  conditions, notification actions). Discovered per parent folder in the
  separate Monitors Library tree (no plain "list all" endpoint exists);
  `queries`/`triggers`/`notifications` are authored as JSON given their deeply
  discriminated shapes. Update is optimistic-concurrency versioned.
- **Connections** (`/api/v1/connections`) — Webhook (also implementing
  Slack/PagerDuty/Datadog/Jira/Opsgenie/Microsoft Teams/New Relic/AWS
  Lambda/Azure/HipChat/Cloud SOAR) and ServiceNow notification destinations —
  the only two connection kinds the Management API accepts full CRUD for.
  Authorization headers and the ServiceNow password are write-only and
  excluded from rollback snapshots.
- **Scheduled Views** (`/api/v1/scheduledViews`) — continuous pre-computed
  indexes. `query`/`indexName`/`startTime` are create-only; disabled rather
  than deleted.
- **Ingest Budgets** (`/api/v2/ingestBudgets`) — daily volume caps per
  field-based scope with a configurable stop/keep-collecting action.
- **Data Forwarding Destinations** (`/api/v1/logsDataForwarding/destinations`)
  and **Data Forwarding Rules** (`/api/v1/logsDataForwarding/rules`) — S3
  archive destinations (IAM-role or access-key authenticated; bucket name is
  create-only) and the rules binding a Partition/Scheduled View id to one.
- **Content Folders** (`/api/v2/content/folders`) — the Content Library tree
  organizing Dashboards/Log Searches/Lookup Tables. Deletion is asynchronous
  (job-based) — the one async write in this app.
- **Dashboards** (`/api/v2/dashboards`) — panels, layout, time range and
  variables, authored as JSON given their nested/discriminated shapes; a
  public-dashboard flag is warned since it bypasses RBAC.
- **Log Searches** (`/api/v1/logSearches`) — saved and scheduled searches,
  with the schedule (cron/interval + notification) authored as JSON.
- **SAML Configuration** (`/api/v1/saml/identityProviders`) — SSO identity
  provider setup. Always emits a high-blast-radius warning: a mistake here can
  lock out every SSO-only user.
- **Users** (`/api/v1/users`) — accounts with role assignment and active
  state. Email is the immutable identity; `isActive` cannot be set on create,
  so a newly created deactivated user gets an immediate follow-up update.
- **Tokens** (`/api/v1/tokens`) — Collector Registration Tokens' name,
  description and Active/Inactive status. The generated secret value is never
  read or written.
- Generalized `lib/sumoLogicApi.ts`'s `listPaged()` to accept `dataField`/
  `nextTokenField` options — Sumo Logic is inconsistent about paged-list
  envelope shapes across endpoints (`{data,next}`, `{data,nextToken}`,
  `{dashboards,next}`, `{logSearches,token}`); added `buildBaseUrl(...,'v2')`
  for the v2-hosted config types; added `pollAsyncJob()` for Content Folders'
  asynchronous delete; added `canonicalJson()` for key-order-independent drift
  comparison of the JSON-authored fields.
- README now documents a full **Coverage** section auditing the entire Sumo
  Logic Management API surface — every managed type, verified-declarative
  candidates deferred to a future release (Password Policy, Account Security
  Policies, Data Masking Rules, Macros, Lookup Tables, Roles V2), and
  intentionally excluded surfaces (Cloud SIEM Enterprise, Cloud SOAR, SLO,
  Sources & Collectors, permissions, the org subdomain, SAML lockdown, and
  more) with reasons for each.

Endpoints and object shapes verified against the official Sumo Logic OpenAPI
specification and the SumoLogic Terraform provider client. Several pagination-
envelope and folder-matching details are reasoned from documentation rather
than a live capture — see the README's "Verify against a live Sumo Logic"
section.

## 0.2.0 — 2026-08-01

Three new configuration types, each a full Security-as-Code pipeline (validate,
deploy, rollback, health check, drift detection and status) over the Sumo Logic
Management API.

- **Partitions** (`/api/v1/partitions`) — manage index partitions as code: name,
  routing expression, retention period and data tier. Upsert by name; update
  sends only the mutable subset (name and tier are immutable in Sumo Logic).
  Rollback restores the prior routing/retention or **decommissions** a newly
  created partition — partitions cannot be deleted, only decommissioned
  (`POST /partitions/{id}/decommission`).
- **Custom Fields** (`/api/v1/fields`) — manage the metadata-tag field schema and
  each field's enabled state. Deploy creates a field (`POST /fields`) then
  converges its state via the dedicated `PUT /fields/{id}/enable` /
  `DELETE /fields/{id}/disable` endpoints. Rollback restores the prior state or
  deletes a newly created field.
- **Roles** (`/api/v1/roles`) — manage RBAC roles: name, description, search
  filter (`filterPredicate`) and capabilities. Upsert by name; user membership is
  left untouched. Rollback restores the prior role body or deletes a newly created
  role.
- Added a reusable paged-list helper (`listPaged`) to the Sumo Logic access lib
  for the token-paginated partitions and roles endpoints.

Endpoints and object shapes verified against the official Sumo Logic API docs and
the SumoLogic terraform provider. Note: the exact `analyticsTier` values a
partition accepts depend on the account's Data Tiers / Flex entitlement, and role
`capabilities` names must match Sumo Logic's capability list.

## 0.1.0 — 2026-08-01

Initial foundation release.

- Manage **Field Extraction Rules** (FERs) as code over the Sumo Logic Management
  API (`/api/v1/extractionRules`), authenticated with an Access ID / Access Key
  (HTTP Basic).
- Full Security-as-Code pipeline for the `field-extraction-rules` configuration
  type: validate, deploy (upsert by rule name), rollback (restore prior body or
  delete a newly created rule), health check, drift detection and status.
- Connections page pairing a Sumo Logic deployment endpoint with an Access ID /
  Access Key, plus a per-connection connectivity test.
- Overview and Setup Guide pages.
