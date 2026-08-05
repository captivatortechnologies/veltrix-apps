# Google SecOps

Manage **Google Security Operations** (Chronicle) configuration as code through
the SecOps REST API, with validation, drift detection and rollback handled by
the Veltrix Security-as-Code pipeline.

This app covers the Chronicle **SIEM / data-platform** surface only — detection
engineering, data ingestion/governance, curated content deployment state, and
dashboards. See [Coverage](#coverage-v060) below for the full managed/excluded
breakdown, including why the SOAR (Siemplify) case-management surface is
intentionally out of scope.

## Authentication

Google SecOps authenticates with a **Google service account**. Create a service
account with the Chronicle API access needed for the configuration types below,
download its **JSON key**, and store the credential as:

- **Password** → the entire service-account JSON key (paste the whole file)

The app builds and signs (RS256) a JWT with the key's private key (via Node's
built-in crypto) and exchanges it for a short-lived Bearer token, refreshing it
automatically. Set the **Region** (e.g. `us`, `europe-west2`), **Project ID** and
**Instance ID** in the app's settings.

## Coverage (v0.6.0)

Coverage was audited against the Chronicle / Google SecOps REST API reference
(`cloud.google.com/chronicle/docs/reference/rest`) and cross-verified against
Google's own **`terraform-provider-google`** (`GoogleCloudPlatform/magic-modules`,
`mmv1/products/chronicle/*.yaml`) — the authoritative, Google-maintained field
schema for every resource, used both to confirm existing types and to source
the field lists for the two types added this pass. Google recently unified
Chronicle (SIEM) and Siemplify (SOAR) under one `chronicle.googleapis.com` API
surface and one REST resource tree (`projects.locations.instances.*`); this app
manages the SIEM/data-platform half of that tree only, as reflected below.

### Managed declarative configuration

| Configuration type | Google SecOps REST operations | Notes |
| --- | --- | --- |
| Reference Lists | `GET`/`POST /referenceLists`, `PATCH /referenceLists/{id}` | No delete — "removal" empties the list |
| Data Tables | `GET`/`POST /dataTables`, `DELETE /dataTables/{id}`; rows via `dataTables/{id}/dataTableRows:bulkReplace` | Column schema fixed at creation |
| Detection Rules | `GET`/`POST /rules`, `PATCH /rules/{id}`, `DELETE /rules/{id}`; `rules:verifyRuleText` pre-check | Rule TEXT only — see Rule Deployments for state |
| Rule Deployments | `GET`/`PATCH /rules/{id}/deployment` | Singleton per rule; enabled/alerting/runFrequency |
| Data Access Labels | `GET`/`POST /dataAccessLabels`, `PATCH`/`DELETE /dataAccessLabels/{id}` | Id-keyed; only query + description mutable |
| Data Access Scopes | `GET`/`POST /dataAccessScopes`, `PATCH`/`DELETE /dataAccessScopes/{id}` | `allowAll` fixed at creation |
| Data Feeds | `GET`/`POST /feeds`, `PATCH`/`DELETE /feeds/{id}` | Per-source secrets write-only |
| Forwarders | `GET`/`POST /forwarders`, `PATCH`/`DELETE /forwarders/{id}` | Agent config as one JSON blob |
| Forwarder Collectors | `GET`/`POST /forwarders/{fwd}/collectors`, `PATCH`/`DELETE .../collectors/{id}` | Nested under a Forwarders item |
| Entity Watchlists | `GET`/`POST /watchlists`, `PATCH`/`DELETE /watchlists/{id}` | Entity membership out of scope |
| Findings Refinements | `GET`/`POST /findingsRefinements`, `PATCH /findingsRefinements/{id}` | No delete — see its Deployments type below |
| **Findings Refinement Deployments** *(new)* | `GET`/`PATCH /findingsRefinements/{id}/deployment` | Singleton; enabled/archived/detector scope |
| Curated Rule Set Deployments | `GET`/`PATCH /curatedRuleSetCategories/{c}/curatedRuleSets/{s}/curatedRuleSetDeployments/{precision}` | State-only; Google owns the content |
| Custom Parsers | `GET`/`POST /logTypes/{logType}/parsers`, activate via `.../parsers/{id}:activate` | Immutable + versioned |
| Parser Extensions | `GET`/`POST /logTypes/{logType}/parserExtensions`, activate via `:activate` | Immutable + versioned |
| Log Processing Pipelines | `GET`/`POST /logProcessingPipelines`, `PATCH`/`DELETE /logProcessingPipelines/{id}` | Client-set id |
| **Native Dashboards** *(new)* | `GET`/`POST /nativeDashboards`, `PATCH`/`DELETE /nativeDashboards/{id}` | Shell + global filters; chart content out of scope |
| BigQuery Export | `GET`/`PATCH /bigQueryExport` | Instance-wide singleton |

Every id-keyed or server-assigned-id resource above is matched by the identity
this app owns (an immutable id, or a display name resolved to the server id at
deploy time, rename-safe via the id stored on the previous successful deploy) —
the same resolve-by-list-then-match convention throughout this app. An object
this app did not create is never modified or deleted; only items this app
itself created are reconciled away when no longer declared.

### Intentionally excluded

- **SOAR (Siemplify) case-management surface** — `cases` and its nested
  `caseAlerts`/`caseComments`/`caseWallRecords`/`chatMessages`/`contextProperties`,
  `environments`/`environmentGroups` (MSSP tenant routing), `integrations` and
  its nested `connectors`/`actions`/`jobs`/`managers` (playbook automation),
  `legacySoarUsers`, `soarDomains`/`soarNetworks` (entity/CIDR classification
  for case triage), `customLists` (Siemplify's own list resource, "used by
  playbooks" per its own API description — distinct from and superseded by
  Reference Lists for this app's SIEM scope), `alertGroupingRules` (configures
  how alerts are grouped **into cases**), `moduleSettings`, `tasks`,
  `requestTemplates`/`emailTemplates`/`dynamicParameters`/`formDynamicParameters`,
  and `slaDefinitions`/`caseCloseDefinitions`/`caseStageDefinitions`/
  `caseTagDefinitions`/`caseQueueFilters`. This app manages Chronicle's
  SIEM/data-platform surface only; SOAR case management is a distinct product
  surface with its own automation/workflow model (`terraform-provider-google`
  ships these as separate `google_chronicle_environment` /
  `google_chronicle_soar_domain` / `google_chronicle_soar_network` /
  `google_chronicle_custom_list` resources, confirming the split).
- **`SOC Roles` (`socRoles`) RBAC** — investigated specifically because it is
  Chronicle's only custom-role/permission resource, so it looks at first glance
  like the RBAC surface this app should manage. Google's own documentation
  ("Manage SOC roles", "SOAR access overview") scopes it to the **SOAR** side
  of the product — roles are assigned from SOAR Settings → User Management to
  control case-queue and playbook permissions, not SIEM data-platform access.
  Excluded for the same reason as the rest of the SOAR surface above, not
  overlooked.
- **One-shot execution, not durable config** — `rules.retrohunts` (`POST
  /rules/{id}/retrohunts` starts a historical re-run of a rule over a past time
  range) and `dataExports` (`POST /dataExports` starts a one-time GCS export
  job for a time range) are both start-a-job actions, not persistent desired
  state (`google_chronicle_retrohunt` / `google_chronicle_data_export` in
  `terraform-provider-google` confirm the same start/poll/finish shape).
- **Read-only / reference data** — `ingestionLogLabels` and
  `ingestionLogNamespaces` (`list`-only, no write methods), `feedSourceTypeSchemas`
  (+ nested `logTypeSchemas`, describes valid Feed `details` shapes — used to
  author a Feed, not itself configurable), `dataTableOperationErrors` /
  `ruleExecutionErrors` (diagnostics), `coverageDetails` (MITRE ATT&CK mapping),
  `ontologyRecords.visualFamilies`, `events`/`iocs`/`iocAssociations`/
  `uniqueEntities` (ingested/derived data, not config), `operations`
  (long-running-operation polling), `announcements`/`systemNotifications`, and
  `threatCollections` (an investigation artifact, not a stable declarative
  resource).
- **User-preference / transient state** — `savedColumnSets` and
  `users.savedColumnSets`/`users.searchQueries` (per-user UI preferences),
  `views` (saved searches), and `dashboardQueries:execute` /
  `dashboardCharts.get`/`.batchGet` (ad-hoc query execution and read-only chart
  views — chart **mutation** is the `nativeDashboards` custom methods below,
  not these).
- **Native Dashboard chart CONTENT** — a dashboard's charts have their own
  create/update/delete lifecycle (`nativeDashboards/{id}:addChart` /
  `:editChart` / `:removeChart`, confirmed via
  `google_chronicle_dashboard_chart` in `terraform-provider-google`) backed by
  an extremely deep, still-evolving visualization schema (per-axis, per-series,
  legend, table, button, markdown, Google Maps and drill-down configuration).
  The Native Dashboards type manages the dashboard shell and its global filters
  only this pass; modeling chart content safely is a substantial follow-on
  scope, deliberately deferred rather than guessed at.
- **Confirmed to exist, schema not safely verifiable this pass** —
  `entitiesBlocklists` (full `create`/`get`/`list`/`patch`/`delete` confirmed on
  the REST reference site, but absent from `terraform-provider-google`, so no
  authoritative field list could be sourced), `enrichmentControls`
  (`create`/`get`/`list`/`disable` only — no `patch`, and its field schema is
  undocumented), `propertySchemaDefinitions` (full CRUD, but its scope —
  SIEM entity/UDM context vs. SOAR case context properties — could not be
  confirmed), `feedServiceAccounts` (a provisioning helper, not itself
  declarative config), and `contentHub` (`contentPacks`,
  `featuredContentNativeDashboards`, `featuredContentRules` — a marketplace
  browse surface). None of these are guessed at; each is a candidate for a
  future pass once its schema can be sourced from Google directly.
- **Secret material** — service-account keys, feed/forwarder/collector
  per-source credentials (already handled as write-only fields within their
  respective types) are never read back or included in drift.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs google-secops

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/google-secops
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
