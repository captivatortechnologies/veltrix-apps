# Changelog

All notable changes to the Wiz app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-04

### Added — five new configuration types, exhausting the Wiz GraphQL config-as-code surface

Researched against the generated Wiz GraphQL SDK type surface
(terraform-provider-wiz's `internal/wiz` Go package,
github.com/AxtonGrams/terraform-provider-wiz — the only publicly available,
schema-derived reference for Wiz's write API) and, where the reference
provider ships a working resource, the literal GraphQL query/mutation text it
sends. See the README's **Coverage** section for the full audit, including
what was verified vs. inferred and what was intentionally left out.

- **Controls (`wiz-controls`).** Manage Wiz custom Controls — a Security Graph
  query + severity that opens an Issue per matching result — through
  `createControl` / `updateControl` / `deleteControl`, reconciled by name.
  `createControl` does not accept `enabled` (a documented defect in the
  reference provider); deploy issues an immediate follow-up `updateControl`
  when a new control declares `enabled: false`. A control's project scope is
  create-time only — `UpdateControlPatch` has no project field — so a changed
  `project_id` is reported as drift but never auto-corrected.
- **Host Configuration Rules (`wiz-host-config-rules`).** Manage Wiz custom
  host/OS-assessment rules — the OVAL-based host counterpart to Cloud
  Configuration Rules — through `createHostConfigurationRule` /
  `updateHostConfigurationRule` / `deleteHostConfigurationRule`, reconciled by
  name against non-builtin rules. The `hostConfigurationRules` list query is
  directly verified (it backs the reference provider's shipped data source);
  the create/update/delete mutations are verified by input/output type shape
  only — that provider defines the Go types but never wired them into a
  working resource.
- **Integrations (`wiz-integrations`).** Manage the 11 API-manageable Wiz
  integration types — Webhook, Slack, Slack Bot, AWS SNS, Azure Service Bus,
  GCP Pub/Sub, PagerDuty, Jira, ServiceNow, Opsgenie, ClickUp — through one
  generic `createIntegration` / `updateIntegration` / `deleteIntegration`
  mutation set (verified: Wiz's actual schema is one generic mutation keyed by
  a `type` enum + `params` union, not one mutation per vendor), reconciled by
  name. These are the objects `wiz-automation-rules`' action `integration_id`
  references — closing a gap where that type could previously only point at
  an integration created by hand in the Wiz console. Every vendor credential
  (Jira password/PAT, ServiceNow password/OAuth secret, a Slack webhook URL,
  a PagerDuty key, ...) is a `password`-typed, write-only field — never read
  back, never compared by drift, matching this app's established secret
  convention. Rollback of an updated integration restores from
  `ctx.previousConfig` (what this app itself last declared) rather than a
  live API read, since Wiz's `params` cannot be safely assumed to echo
  secrets back.
- **SAML Identity Providers (`wiz-saml-identity-providers`).** Manage Wiz SAML
  SSO identity providers and their group-to-role mappings through
  `createSAMLIdentityProvider` / `updateSAMLIdentityProvider` /
  `deleteSAMLIdentityProvider` (all three verified verbatim against the
  reference provider), reconciled by name. The signing certificate is the
  IdP's *public* key — not a secret — and is diffed by drift like any other
  field.
- **Projects (`wiz-projects`).** Manage Wiz Projects — the grouping construct
  for cloud accounts/organizations/Kubernetes clusters, owners and a risk
  profile — through `createProject` / `updateProject` (verified verbatim
  against the reference provider, including its `override` full-replace
  update semantics), reconciled by name. Wiz has **no `deleteProject`
  mutation** (verified absent) — only `archived: true`. Rollback of a
  project this app created therefore archives it and renames it to its own
  slug, the exact verified pattern the reference provider itself uses to
  "delete" a project (project names are unique tenant-wide, so an archived
  project must free its name for reuse). `is_folder` is create-time only.
- All five types ship the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus), reuse the shared `WizClient` GraphQL
  client, and extend the audit-log **drift attribution** ("who changed it +
  when") introduced in 1.1.0 to every new type (except Integrations, whose
  params are intentionally never read back to correlate against).
- **Intentionally excluded** (see README Coverage): cloud-account connectors
  (`createConnector` — vendor-varying secret material belongs to a dedicated
  cloud-credential onboarding flow, not a canvas secret field), the
  `*_associations` resources (redundant with the `security_sub_categories`
  field already inline on Controls/Cloud/Host Configuration Rules), issue
  exceptions and saved filters (verified absent from the schema — no
  `Exception`/`Exclusion`/`SavedFilter` mutation exists), CI/CD scan policies
  and Wiz platform users (out of this pass's scope; documented as valid
  future additions).

## 1.2.0 — 2026-07-26

### Added
- **Automation rules (`wiz-automation-rules`).** Manage Wiz automation rules —
  the notification/remediation layer — as code through `createAutomationRule` /
  `updateAutomationRule` / `deleteAutomationRule`, reconciled by rule name. Each
  rule declares a trigger source (Issues, Cloud events, Controls, Configuration
  findings), one or more trigger types (Created/Updated/Resolved/Reopened), an
  optional JSON filter, and one action that delivers to an existing Wiz
  integration (Slack, webhook, email, ServiceNow, Jira, SNS, PagerDuty, …) with
  optional JSON action parameters. Missing rules are created; existing rules are
  updated to the declared spec. Rollback deletes created rules and restores the
  scalar state (name/description/trigger/filters/enabled) of modified rules.
- **Reports (`wiz-reports`).** Manage Wiz graph-query report definitions as code
  through `createReport` / `updateReport` / `deleteReport` (report type
  `GRAPH_QUERY`), reconciled by report name. Each report runs a saved Security
  Graph query, on demand or on an hourly schedule (`runIntervalHours` +
  `runStartsAt`), optionally scoped to a project. Rollback deletes created
  reports and restores the prior query/schedule of modified reports.
- **Security frameworks (`wiz-security-frameworks`).** Manage Wiz custom security
  frameworks — the compliance/policy grouping (categories → sub-categories) that
  Controls and Cloud Configuration Rules map to, beyond a rule-level control flag
  — as code through `createSecurityFramework` / `updateSecurityFramework` /
  `deleteSecurityFramework`, reconciled by framework name against non-builtin
  frameworks. Rollback deletes created frameworks and restores the prior
  categories (ids preserved) of modified frameworks.
- All three types ship the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus) and reuse the shared Wiz GraphQL client
  and the audit-log **drift attribution** ("who changed it + when") introduced in
  1.1.0.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Wiz object (service accounts, custom cloud configuration rules), each
  reported difference is now annotated with the person who made the last manual
  change and when, resolved from the Wiz **audit log** (`auditLogEntries`). The
  platform stores the `actor` on each diff and the drift view renders it, so a
  drift alert answers *who* and *when*, not just *what*.
  - Attribution queries the audit log per drifted object over a ~7-day window
    (`filterBy: { timestamp: { after: … } }`) and correlates entries to the
    drifted object by matching its id (preferred) or name against the entry's
    `actionParameters` — Wiz's audit log has no per-object subject field, so
    correlation is done client-side.
  - It picks the most recent **human** entry (one bearing a `user`, not a
    service account), preferring change-type actions (`Create*`, `Update*`,
    `Delete*`, `Rotate*`, …) and falling back to the most recent human entry
    otherwise. The actor carries the user's id, name and email plus the action
    and timestamp.
  - Veltrix's own deploys authenticate as a Wiz **service account** (recorded
    with no `user`) and are therefore never treated as a human actor; the
    connection's Client ID is additionally excluded so the attribution reflects
    the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a timeout, an empty or unavailable audit log, or no
    usable human entry, the diff is reported without an actor and the drift view
    shows "—". Only objects that actually drifted are queried (one audit query
    per drifted object).
