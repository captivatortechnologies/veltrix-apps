# Sumo Logic

Manage [Sumo Logic](https://www.sumologic.com/) (cloud SIEM & log analytics) as
code. Author configuration in the Configuration Canvas and drive it through the
Veltrix Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback — over the Sumo Logic **Management API**.

Sumo Logic is SaaS: there is no infrastructure to provision. The app talks to
the public Management API over HTTPS with a valid TLS certificate.

## What it manages

| Configuration type | Sumo Logic object | API surface |
| --- | --- | --- |
| Field Extraction Rules | Field Extraction Rule (FER) | `/api/v1/extractionRules` |
| Partitions | Index Partition | `/api/v1/partitions` |
| Custom Fields | Field schema + enabled state | `/api/v1/fields` |
| Roles | RBAC Role | `/api/v1/roles` |
| Monitors | Alert (query + triggers + notifications) | `/api/v1/monitors` |
| Connections | Notification destination (Webhook/ServiceNow) | `/api/v1/connections` |
| Scheduled Views | Continuous pre-computed index | `/api/v1/scheduledViews` |
| Ingest Budgets | Daily ingest volume cap | `/api/v2/ingestBudgets` |
| Data Forwarding Destinations | S3 archive/forward bucket | `/api/v1/logsDataForwarding/destinations` |
| Data Forwarding Rules | Partition/View → Destination binding | `/api/v1/logsDataForwarding/rules` |
| Content Folders | Content Library folder | `/api/v2/content/folders` |
| Dashboards | New-style panel dashboard | `/api/v2/dashboards` |
| Log Searches | Saved / scheduled search | `/api/v1/logSearches` |
| SAML Configuration | SSO identity provider config | `/api/v1/saml/identityProviders` |
| Users | User account | `/api/v1/users` |
| Tokens | Collector Registration Token | `/api/v1/tokens` |

A Field Extraction Rule (FER) parses fields from log messages **at ingest time**,
so the parsed fields are available for search, alerts and dashboards without
query-time parsing.

## Authentication

Sumo Logic authenticates with an **Access ID** + **Access Key** pair sent as HTTP
Basic auth on every request:

```
Authorization: Basic base64("<accessId>:<accessKey>")
```

Create a key in the Sumo Logic UI under **Manage → Security → Access Keys** →
_Create New Access Key_. The **Access Key** is displayed only once — copy it
immediately. The key's user/role needs the relevant **Manage \*** role
capability for each configuration type you use (e.g. Manage Field Extraction
Rules, Manage Monitors, Manage Users and Roles, Manage SAML Settings).

- Access ID → stored as the Veltrix credential's `username`.
- Access Key → stored as the credential's write-only `apiToken` secret.

Docs:
- API auth & endpoints — https://help.sumologic.com/docs/api/about-apis/getting-started/
- Access keys — https://help.sumologic.com/docs/manage/security/access-keys/

## Deployment / base URL

The Management API base URL is **per-deployment**:

```
https://api.<deployment>.sumologic.com/api/v1/
```

US1 uses `api.sumologic.com`; other regions carry the deployment in the host
(e.g. `api.us2.sumologic.com`, `api.eu.sumologic.com`, `api.au.sumologic.com`).
Enter the deployment host as the connection **endpoint** on the Connections page —
the app normalizes it to the `/api/v1` base. See the deployment table:
https://help.sumologic.com/docs/api/getting-started/#which-endpoint-should-i-should-use

Ingest Budgets, Content Folders and Dashboards live under `/api/v2` on the same
host — `lib/sumoLogicApi.ts`'s `buildBaseUrl(component, connectivity, 'v2')`
derives it from the same connection endpoint.

## Field Extraction Rules API

Confirmed against the official docs and the SumoLogic Terraform provider client
(`sumologic/sumologic_extraction_rule.go`):

| Operation | Method & path                        | Body / result                                          |
| --------- | ------------------------------------ | ------------------------------------------------------ |
| List      | `GET /api/v1/extractionRules`        | `{ "data": [ ExtractionRule, … ] }`                    |
| Create    | `POST /api/v1/extractionRules`       | body `{ name, scope, parseExpression, enabled }` → created `ExtractionRule` (with `id`) |
| Get       | `GET /api/v1/extractionRules/{id}`   | `ExtractionRule`                                       |
| Update    | `PUT /api/v1/extractionRules/{id}`   | body `{ name, scope, parseExpression, enabled }` (no `id`) |
| Delete    | `DELETE /api/v1/extractionRules/{id}`| —                                                      |

Rules are **upserted by name**: the deploy handler lists live rules, matches by
name (case-insensitive), then `PUT`s an existing rule or `POST`s a new one. Each
deploy records, per rule, the prior body (or `null` when it created the rule) plus
the rule id, so **rollback** restores the prior body or deletes a rule this deploy
created. **Drift** compares `scope`, `parseExpression` and `enabled` against the
live rule.

Docs — https://www.sumologic.com/help/docs/api/field-extraction-rules/

## Partitions, Custom Fields and Roles

Added in 0.2.0 — see `CHANGELOG.md` for the full write-up. In short: **Partitions**
upsert by name and are decommissioned rather than deleted (`/api/v1/partitions`);
**Custom Fields** upsert by name and toggle their enabled state via dedicated
enable/disable endpoints (`/api/v1/fields`); **Roles** upsert by name and leave
user membership untouched (`/api/v1/roles`).

## Monitors

`/api/v1/monitors` — alert definitions (query + trigger conditions +
notification actions). Unlike every other config type in this app, there is
**no plain "list all" endpoint** — monitors live in a folder tree (the
**Monitors Library**, separate from the Content Library used by Dashboards/Log
Searches/Folders) and are discovered by reading a folder's `children`
(`GET /v1/monitors/{parentId}`). This type upserts by matching a declared
`name` against the children of its resolved `parentId`, defaulting to the
always-present root folder (`GET /v1/monitors/root`) when left blank. Monitor
names are only unique **within their parent folder**.

`queries`, `triggers` and `notifications` are deeply nested, heavily
discriminated structures (11 trigger detection methods, a dozen+ notification
connection types) — authored as JSON in the canvas rather than fully typed
fields, the same approach this app's Dashboards use and Cisco Meraki's Group
Policies pioneered in this codebase.

Update is **optimistic-concurrency versioned** — Sumo Logic rejects a `PUT`
whose `version` doesn't match the live value. Deploy re-reads the full monitor
immediately before updating to capture the current version; rollback re-reads
it again immediately before restoring (the version changes with every write).

Docs — https://help.sumologic.com/docs/api/monitors/

## Connections

`/api/v1/connections` — notification destinations Monitors (and scheduled
search notifications) send to. The Management API only accepts full
create/update/delete for **two** connection kinds — verified against the
official OpenAPI spec's `ConnectionDefinition` discriminator and the DELETE
endpoint's required `type` pattern (`^(WebhookConnection|ServiceNowConnection)$`):

- **Webhook** — a generic mechanism that also implements Slack, PagerDuty,
  Datadog, Jira, Opsgenie, Microsoft Teams, New Relic, AWS Lambda, Azure,
  HipChat and Sumo Logic Cloud SOAR by setting a `webhookType` on the same
  webhook body.
- **ServiceNow** — its own dedicated username/password-based kind.

Every other integration visible in the Sumo Logic UI (Email, native
Slack/Teams "apps", CloudSOAR incident templates) either has no create/update
API or is configured entirely inside the third-party product — see Coverage.

⚠ **Secrets are write-only.** A Webhook's authorization `headers` and a
ServiceNow `password` are never echoed back by a `GET` — deploy can set them,
but rollback and drift cannot see or restore their previous values (they are
excluded from the captured rollback snapshot; see `_shared.ts`).

Docs — https://www.sumologic.com/help/docs/api/connection-management/

## Scheduled Views

`/api/v1/scheduledViews` — a continuous, pre-computed index built from a query.
`query`, `indexName` and `startTime` are **create-only**: the update endpoint
(`UpdateScheduledViewDefinition`) does not accept them, so editing them on an
existing view is silently ignored by Sumo Logic — this app's drift detection
surfaces a query mismatch as an `info`-severity diff (not `warning`) since it
cannot be corrected by redeploying. A Scheduled View cannot be permanently
deleted, only **disabled** (`DELETE /scheduledViews/{id}/disable`) — rollback
of a newly created view disables it rather than removing it.

Docs — https://help.sumologic.com/docs/api/scheduled-views/

## Ingest Budgets

`/api/v2/ingestBudgets` — a daily (or per-minute, depending on account
entitlement) ingest volume cap applied to messages matching a field-based
`scope`, with a configurable action (`stopCollecting`/`keepCollecting`) once
capacity is reached. Full CRUD, upserted by name. Update requires the **entire**
definition on every `PUT` per the official docs ("All properties specified in
the request are required") — this type always sends the full body, never a
partial patch.

Docs — https://help.sumologic.com/docs/api/ingest-budget-v2/

## Data Forwarding (Destinations + Rules)

Two related but independently-managed config types, mirroring the two distinct
Management API resources:

- **Data Forwarding Destinations** (`/api/v1/logsDataForwarding/destinations`)
  — an S3 bucket Sumo Logic can archive/forward data to, authenticated via an
  IAM role (recommended) or an AWS access key pair. `bucketName` is
  **create-only** (the update schema omits it) — like Scheduled Views' query,
  a bucket-name edit on an existing destination is surfaced as `info`-severity
  drift rather than applied.
- **Data Forwarding Rules** (`/api/v1/logsDataForwarding/rules`) — binds an
  existing Partition or Scheduled View (by its own `id`, the rule's `indexId`)
  to a destination. Unlike every other config type in this app, the identity
  (`indexId`) is **caller-supplied** — the id of an object you already manage
  elsewhere — rather than something Sumo Logic assigns.

⚠ **AWS credentials are write-only.** `accessKeyId`/`secretAccessKey` are never
echoed back by a `GET` — deploy can set them, but rollback cannot see or
restore their previous values.

Docs — https://help.sumologic.com/docs/api/data-forwarding/

## Content Folders

`/api/v2/content/folders` — the tree that organizes Dashboards, Log Searches
and Lookup Tables (a **separate** tree from the Monitors Library above). There
is no plain "list all folders" endpoint; every folder here declares an
existing `parentId` (your Personal folder — `GET /v2/content/folders/personal`
— or another folder you already manage), discovered the same
read-children-and-match-by-name way Monitors are. Folder **deletion is
asynchronous**: `DELETE /content/{id}/delete` returns a job id that must be
polled to completion (`lib/sumoLogicApi.ts`'s `pollAsyncJob`) — the one
async operation in this app; every other config type's writes are synchronous.

Docs — https://help.sumologic.com/docs/api/content-management/

## Dashboards

`/api/v2/dashboards` — the "new" panel-based dashboard (not the legacy
Report). Discovered per-folder the same way as Monitors/Log Searches, defaulting
to the caller's Personal folder. `timeRange`, `panels`, `layout` and
`variables` are deeply nested and heavily discriminated (six+ panel types,
several time-range shapes, three variable source kinds) — authored as JSON.
`isPublic` is flagged with a validation warning: a public dashboard is
viewable via its link **without a Sumo Logic account**, bypassing RBAC.

Docs — https://help.sumologic.com/docs/api/dashboards-v2/

## Log Searches

`/api/v1/logSearches` — a saved search, optionally scheduled (cron/interval +
a notification that is itself a discriminated union of
Email/Webhook/ServiceNow/SaveToView/SaveToLookup/Alert task types). Discovered
per-folder like Dashboards. The list endpoint uses yet another envelope shape
than most of this app's other paged endpoints — `{ logSearches: [...], token }`
rather than `{ data: [...], next }` — handled via `listPaged`'s
`dataField`/`nextTokenField` options in `lib/sumoLogicApi.ts`.

Docs — https://help.sumologic.com/docs/api/log-searches/

## SAML Configuration

`/api/v1/saml/identityProviders` — SSO identity provider configuration
(issuer, certificate, SP-initiated login, role/attribute mapping, on-demand
user provisioning). Unlike every other list endpoint in this app, `GET` returns
a **bare array** — no `{ data: [...] }` envelope, no pagination.

⚠ **HIGH BLAST RADIUS.** This configures how users sign in to the **entire**
organization — a wrong issuer, certificate or URL can lock out every SSO-only
user. `validate.ts` always emits a prominent warning regardless of whether the
declared configuration otherwise looks correct.

Docs — https://www.sumologic.com/help/docs/api/saml-configuration-management/

## Users

`/api/v1/users` — user accounts (first/last name, email, role assignment,
active state). **Email is the identity and is immutable after creation** — the
update endpoint does not accept it (Sumo Logic's email-change flow,
`POST /users/{id}/email/requestChange`, requires the user to click a
confirmation link and is out of scope for declarative config). `isActive`
cannot be set on **create** — a newly created user who should start
deactivated gets an immediate follow-up `PUT`. Deploy looks a user up directly
via `GET /users?email=<email>` rather than paging through the whole
organization.

Docs — https://help.sumologic.com/docs/api/user-management/

## Tokens

`/api/v1/tokens` — Collector Registration Tokens: a shared secret Collectors
present to auto-register with the organization without an individual user
credential. This config type manages the token's **name, description and
Active/Inactive status only** — the generated secret value
(`encodedTokenAndUrl`, embedded in the installer command) is assigned by Sumo
Logic and never re-exposed after creation, so it is never read or written
here. Update is optimistic-concurrency versioned, the same shape as Monitors.

Docs — https://help.sumologic.com/docs/api/tokens-library-token-management/

## Verify against a live Sumo Logic

The following were reasoned from official docs (the OpenAPI spec at
`api.sumologic.com/docs/sumologic-api.yaml`) + the Terraform provider but
should be confirmed against a live tenant before GA:

- **List envelope & pagination naming.** Most list endpoints return
  `{ data: [...], next }`, but Data Forwarding uses `{ data, nextToken }`,
  Dashboards uses `{ dashboards, next }`, and Log Searches uses
  `{ logSearches, token }`. `listPaged()` supports all of these via
  `dataField`/`nextTokenField` options, based on the OpenAPI schemas, not a
  live capture.
- **Monitors Library folder-child matching.** `findMonitorChild`/reading a
  folder's `children` to discover an existing monitor by name is reasoned from
  `MonitorsLibraryFolderResponse.children`; not independently re-verified
  against a live folder with many mixed monitor/sub-folder children.
- **SAML configuration list.** The bare-array (non-enveloped,
  non-paginated) shape of `GET /saml/identityProviders` is as documented in
  the OpenAPI spec; an organization with dozens of configurations is not an
  independently tested scenario.
- **Connectivity probe.** The app uses `GET /api/v1/extractionRules` as its
  connection-level reachability + auth check (it also validates the FER read
  permission); the newer config types add their own lightweight
  `healthCheck.ts` probes against their respective list endpoints.
- **Role capability names.** `roles.capabilities` and the specific `Manage *`
  capability each new config type's Access Key needs must match Sumo Logic's
  exact capability list — not independently enumerated here.

## Layout

```
apps/sumo-logic/
├── manifest.yaml
├── lib/sumoLogicApi.ts                          # REST client: v1/v2 base URL, Basic auth, generic pagination, async-job polling
├── config-types/
│   ├── field-extraction-rules/                  # Parsing
│   ├── partitions/                              # Data Management
│   ├── fields/                                  # Data Management
│   ├── scheduled-views/                         # Data Management
│   ├── ingest-budgets/                          # Data Management
│   ├── data-forwarding-destinations/            # Data Management
│   ├── data-forwarding-rules/                   # Data Management
│   ├── roles/                                   # Access Control
│   ├── users/                                   # Access Control
│   ├── saml-configuration/                      # Access Control
│   ├── tokens/                                  # Access Control
│   ├── monitors/                                # Alerting & Notifications
│   ├── connections/                             # Alerting & Notifications
│   ├── folders/                                 # Content Library
│   ├── dashboards/                              # Content Library
│   └── log-searches/                            # Content Library
│       # each: canvas.yaml + defaults.yaml + full pipeline handlers + __tests__/
├── handlers/testConnection.ts                   # connection connectivity test
├── server/index.ts                              # /meta + /settings
└── client/                                      # Overview, Setup Guide, Connections pages
```

## Development

```
cd apps/sumo-logic
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs sumo-logic            # run handler tests
node ../../scripts/validate-app.mjs apps/sumo-logic     # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against the official Sumo Logic Management API OpenAPI
specification (`https://api.sumologic.com/docs/sumologic-api.yaml`) and the
SumoLogic Terraform provider's resource set, as of 2026-08-04.

### Managed declarative configuration (16 configuration types)

| Configuration type | Management API operations |
| --- | --- |
| Field Extraction Rules | list/create/get/update/delete `/api/v1/extractionRules` |
| Partitions | list/create/update/decommission `/api/v1/partitions` |
| Custom Fields | list/create/delete `/api/v1/fields` + dedicated enable/disable |
| Roles | list/create/get/update/delete `/api/v1/roles` |
| Monitors | folder-scoped create/read/update/bulk-delete `/api/v1/monitors` |
| Connections (Webhook, ServiceNow) | list/create/get/update/delete `/api/v1/connections` |
| Scheduled Views | list/create/get/update/disable `/api/v1/scheduledViews` |
| Ingest Budgets | list/create/get/update/delete `/api/v2/ingestBudgets` |
| Data Forwarding Destinations | list/create/get/update/delete `/api/v1/logsDataForwarding/destinations` |
| Data Forwarding Rules | list/create/get/update/delete `/api/v1/logsDataForwarding/rules` |
| Content Folders | folder-scoped create/get/update + async delete `/api/v2/content/folders` |
| Dashboards | folder-scoped list/create/get/update/delete `/api/v2/dashboards` |
| Log Searches | folder-scoped list/create/get/update/delete `/api/v1/logSearches` |
| SAML Configuration | list (bare array)/create/update/delete `/api/v1/saml/identityProviders` |
| Users | find-by-email/create/get/update/delete `/api/v1/users` |
| Tokens | list/create/get/update/delete `/api/v1/tokens` |

Every upsert-by-name type captures the prior live state before writing so
rollback can restore it (or delete/disable what it created); write-only
secrets (Webhook headers, ServiceNow password, AWS access keys) are
intentionally excluded from captured rollback snapshots since Sumo Logic never
echoes them back — see the per-type sections above and each `_shared.ts`.

### Verified genuinely declarative, deferred to a future release

These were researched and confirmed to have full write support, but are held
back from this release to keep its scope matched to what was explicitly
requested — each is a strong, low-risk candidate for a follow-up:

- **Account Password Policy** (`/api/v1/passwordPolicy`) — a singleton
  org-wide password policy (min length, complexity, lockout, MFA
  requirement). Simple PUT-to-update, "delete" resets to defaults.
- **Account Security Policies** (`/api/v1/policies/{audit,dataAccessLevel,
  maxUserSessionTimeout,searchAudit,shareDashboardsOutsideOrganization,
  userConcurrentSessionsLimit}`) — six org-wide security toggles, each its own
  GET/PUT sub-resource; would need bundling into one singleton canvas item.
- **Data Masking Rules** (`/api/v1/dataMaskingRules`) — regex-based PII/PCI
  masking applied before indexing; same flat shape as Field Extraction Rules.
- **Search Macros** (`/api/v2/macros`) — reusable named search snippets; a
  search-authoring convenience rather than a security control.
- **Lookup Tables** (`/api/v1/lookupTables`) — the schema (fields, primary
  keys, size-limit action, TTL) is declarative like Partitions, but a table's
  usefulness depends entirely on its row data, populated via a separate
  upload/ingest API — the same "config, not data" boundary the Roles config
  type already applies to user membership.
- **Roles V2** (`/api/v2/roles`) — a newer roles API with
  `securityDataFilter`/`auditDataFilter`/`logAnalyticsFilter` and embedded
  `users`. The existing Roles config type covers RBAC via the stable v1 API;
  migrating would change an existing config type's shape rather than add one.

### Intentionally excluded

- **Cloud SIEM Enterprise (CSE)** — ~30 dedicated resources (aggregation/chain/
  threshold/outlier/first-seen rules, entities, insights, log mappings, match
  lists, tag schemas, network blocks, automations, ...). A distinct, large
  product surface — out of scope for this app; would warrant its own app.
- **Cloud SOAR** (playbooks) — a separate product surface from core Sumo
  Logic SIEM/log-analytics configuration.
- **SLO** (Service Level Objectives + SLO folders) — a reliability/observability
  feature distinct from security-as-code configuration.
- **Sources & Collectors** (15+ source types — HTTP, CloudTrail, CloudWatch,
  S3, Azure Event Hub/Metrics, GCP, O365 Audit, Kinesis Log/Metrics, RUM,
  polling, local file, Windows Event Log, cloud-to-cloud, cloud syslog — plus
  Collector/Installed Collector/OT Collector management) — a large data-
  ingestion-pipeline surface tied to live installed agents, with the same
  device-scale fan-out risk Cisco Meraki's device/port-level resources are
  excluded for in this platform. A dedicated "Sources" app/major version would
  be the right home.
- **Installed Apps** (App Catalog content installs) — installing a
  pre-built dashboard/monitor package, closer to marketplace content
  installation than declarative security configuration.
- **Monitors Library folder management as its own config type** — the root
  Monitors folder always exists and is auto-resolved by the Monitors config
  type's `parentId`; a dedicated folder-CRUD type would mostly manage cosmetic
  nesting. Reference an existing sub-folder's id (created in the Sumo Logic
  UI) via `parentId` if you already organize monitors that way.
- **Content Management bulk import/export/copy/move** (whole-tree JSON
  export, Admin Recommended folder jobs) — bulk migration tooling, not
  steady-state per-object configuration; the typed config types (Dashboards,
  Log Searches, Monitors, Folders) cover the individual objects instead.
- **Content/Monitor permissions** (`/api/v2/content/{id}/permissions`,
  `/api/v1/monitors/{id}/permissions`) — explicit ACL grants on individual
  content items to specific users/roles, cross-referencing arbitrary content
  ids from every other config type in this app — deferred for complexity and
  safety margin.
- **Organization Subdomain** (`/api/v1/account/subdomain`) — a single
  org-wide login URL; changing it breaks every existing bookmarked/SSO-
  configured login link for every user. Too disruptive to manage as
  declarative code, the same reasoning Cisco Meraki applies to its
  VLANs-enabled toggle.
- **SAML Allowlisted Users / SAML Lockdown** (`/api/v1/saml/allowlistedUsers`,
  `/api/v1/saml/lockdown/enable`) — a password-login bypass list and an
  emergency SSO-lockdown toggle; break-glass mechanisms better operated
  interactively than as steady-state config.
- **Data Deletion Rules** — a "run once" GDPR-style purge job over a query and
  time range. An imperative one-time action, not durable desired state (the
  same category as Live Tools/action endpoints excluded elsewhere in this
  platform).
- **Read-only / monitoring surfaces** — events, clients, traffic, topology,
  usage & estimated-usage, audit logs, health, quota endpoints, permission
  summaries. Read-only, not configuration.
- **Access Keys** (the very Access ID/Access Key this app authenticates
  with) — bootstrap credential management, a platform Connections concern,
  not canvas configuration.

Primary references: the official Sumo Logic API reference
(https://api.sumologic.com/docs/), the Management API overview
(https://help.sumologic.com/docs/api/), and the endpoint-specific docs linked
in each section above and in every config type's `_shared.ts`.
