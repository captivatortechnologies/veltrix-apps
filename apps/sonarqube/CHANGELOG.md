# Changelog

All notable changes to the SonarQube app are documented here.

## 0.4.0 — 2026-08-04

Five new config types, exhausting SonarQube's remaining genuinely declarative
Web API surface (research-first, verified live against a running SonarQube
instance's own `api/webservices` reflection endpoints —
`api/webservices/list?include_internals=true` and
`api/webservices/response_example` — rather than scraped docs). Every type is
driven through the full Security-as-Code pipeline (validate / deploy /
rollback / health-check / drift-detect / status), bringing this app to **9**
config types. See the README's new **Coverage** section for the complete
managed-vs-excluded inventory and reasoning.

- **Global Settings** config type — arbitrary instance-wide `sonar.*`
  properties (key + a single value or a multi-value list) over
  `/api/settings` (`set`, `reset`, `values`). Global scope only; `component`
  is never sent, and PROPERTY_SET (`fieldValues`) settings are out of scope
  (unpredictable per-setting field schemas). Rollback restores the prior
  explicit value, or resets to default if this deploy introduced the first
  override.
- **New Code Periods** config type — the New Code baseline (Previous version /
  Number of days / Reference branch / Specific analysis) at the global,
  project or branch level over `/api/new_code_periods` (`set`, `show`,
  `unset`). Specific-analysis overrides carry an explicit validation warning:
  analysis ids are ephemeral and SonarQube purges old analyses over time.
- **Global Permissions** config type — direct instance-wide permission grants
  to groups (admin, gateadmin, profileadmin, provisioning, scan,
  applicationcreator, portfoliocreator) over `/api/permissions`
  (`add_group`/`remove_group`, sent without `projectId`/`projectKey` to target
  the global scope; the internal `groups` action is the only way to read them
  back — the same situation Permission Templates already faces with
  `template_groups`). Only the groups you declare are reconciled; per-user
  overrides are intentionally out of scope. Distinct from Permission
  Templates, which auto-apply to matching *new* projects rather than granting
  permissions directly.
- **Quality Profile Rule Overrides** config type — an explicit severity,
  parameter values and/or "prioritized rule" flag for one rule in one quality
  profile, over `/api/qualityprofiles` (`activate_rule`, `deactivate_rule`)
  plus `/api/rules/search?f=actives` to read back the live override. A
  companion to Quality Profiles' bulk `activateRuleKeys` (which activates at
  each rule's default severity) — whichever config type deploys last wins for
  a given rule, a documented interaction rather than a bug. Never touches a
  rule it did not itself declare.
- **ALM Settings** config type — instance-level DevOps Platform Integration
  connections (GitHub, GitLab, Bitbucket Server, Bitbucket Cloud, Azure
  DevOps) over `/api/alm_settings` (`create_*`, `update_*`, `delete`,
  `list_definitions`). Secrets (client secret, private key, webhook secret,
  personal access token) are write-only — SonarQube never returns them, so
  they can be set/updated but never diffed for drift or restored on rollback,
  the same posture as this app's existing Webhooks secret. Changing an
  existing key's ALM type is refused rather than silently deleted and
  recreated, since the prior secrets could never be recovered to make that
  safe or reversible. Per-project repository bindings and the deprecated
  project-import actions are out of scope.
- `lib/sonarqubeApi.ts`'s `formEncode`/`postForm` now also accept a
  `string[]` value for a param, encoded as the same key repeated once per
  element — SonarQube's convention for multi-value form params (used by
  Global Settings' `values`).

> **API notes.** `api/permissions/groups` and `api/qualityprofiles`'s
> `activate_rule`/`rules/search?f=actives` shapes were confirmed against a
> live, real-world SonarQube instance (SonarSource's own public reference
> deployment), not just the documented schema — see each config type's
> `_shared.ts` header for the exact verified response shapes.

## 0.3.0 — 2026-08-01

**BYOL infrastructure hosting** — provision and manage a dedicated SonarQube stack
(bring-your-own-license) end to end from the new **Infrastructure** page, following
the node_tiers-native model. Define the topology, deploy to a Veltrix-hosted or your
own cloud account (BYOC), then manage its lifecycle here.

- **Two scalable node tiers** — Application nodes (SonarQube web server + compute
  engine, the ALB targets on HTTP 9000) and Search nodes (Elasticsearch). Counts +
  cluster placement are authored per-tier and persisted ONLY in a `node_tiers` JSONB
  column (no legacy indexer/search-head columns). A single deployment collapses to one
  all-in-one node; a distributed (Data Center Edition) stack expands each tier, and a
  distributed Elasticsearch search cluster is enforced at ≥3 nodes for a real quorum.
- **Fixed supporting infra** — a single external PostgreSQL database plus the
  foundation (network, load balancer, DNS, TLS, secrets), added to the resource plan
  automatically. Multi-site placement (AZ or, for BYOC, region) spreads scalable-tier
  nodes across sites.
- **Deployment console** — the shared SDK `<ByolInfrastructureManager>` over app-owned
  `/byol` routes: list/create/edit stacks, a Terraform-style plan diff
  (add/change/destroy) enriched with the reserved subnet + canonical tenant/cost tags,
  Apply/Destroy with an activity timeline, and start/stop/restart lifecycle.
- **Usage metering** — an append-only lifecycle state log + a daily idempotent
  node-hours ledger (foundation for usage-based cloud billing), collected via
  `POST /byol/usage/collect` and read via `GET /byol/usage`.
- **Declarative InfraSpec** (`infra/spec.ts`) — composes the same generic OpenTofu
  modules as every other BYOL app purely by declaring data: HTTP front door on 9000,
  Elasticsearch 9001 and PostgreSQL 5432 as peer/self rules, WAF on, health via
  `/api/system/status`.

> New app-owned tables are all `sonarqube_`-prefixed (`sonarqube_byol_*`). Ports and
> the Data Center Edition topology (app/search/PostgreSQL split) are reasonable
> defaults — verify against your SonarQube deployment guidance
> (docs.sonarsource.com) before treating them as production-grade.

## 0.2.0 — 2026-08-01

Three new config types, each driven through the full Security-as-Code pipeline
(validate / deploy / rollback / health-check / drift-detect / status) over the
SonarQube Web API. Every resource is upserted by NAME (not id/key) for robustness
across SonarQube versions.

- **Quality Profiles** config type — create profiles and set their language, parent
  (inheritance), default flag and activated rule keys over `/api/qualityprofiles`
  (`create`, `change_parent`, `activate_rules`, `set_default`, `search`, plus
  `delete` / `deactivate_rule` on rollback). Identity is the `(name, language)` pair,
  so the same name can be reused across languages. Built-in profiles (e.g. Sonar way)
  are set-default only. Rollback deletes profiles we created and deactivates rules we
  activated; drift compares parent, default and declared rule activation.
- **Webhooks** config type — create / update global or project webhooks over
  `/api/webhooks` (`create`, `update`, `delete`, `list`) with an optional HMAC secret.
  Upserted by name within a scope (blank project = global). Rollback deletes created
  webhooks and restores a changed URL.
- **Permission Templates** config type — create / edit templates and reconcile group
  grants over `/api/permissions/*_template` (`create_template`, `update_template`,
  `search_templates`, `add_group_to_template`, `remove_group_from_template`,
  `template_groups`, `delete_template`). Only the groups you list are managed;
  undeclared grants are left untouched. Rollback deletes created templates and restores
  prior description / project-key pattern / declared-group grants.

> **API notes / caveats.** SonarQube never returns a webhook secret (only `hasSecret`),
> so a secret can be set/updated but is never read back for drift nor restored on
> rollback. The form-encoder drops blank params, so an empty secret / description /
> project-key pattern leaves an existing value unchanged rather than clearing it.
> `qualityprofiles/activate_rules` addresses the profile by KEY (resolved from search)
> and `rule_key` takes a comma-separated list (rules/search filter semantics). The
> `permissions/template_groups` response envelope (`{ groups: [{ name, permissions }] }`)
> and the exact permission-key set should be verified against your SonarQube version.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Quality Gates** config type — create / edit SonarQube quality gates (name,
  default flag, and pass/fail conditions authored as `<metric> <LT|GT> <threshold>`,
  e.g. `new_coverage LT 80`) over the SonarQube Web API (`/api/qualitygates`), with
  validate / deploy (upsert gate by name + reconcile conditions by metric) / rollback
  (destroy created gates, restore prior conditions, restore prior default) /
  health-check / drift-detect / status.
- **Connectivity test** against the SonarQube Web API (`/api/system/status` +
  `/api/authentication/validate`, HTTP or HTTPS, self-signed TLS tolerated) using a
  SonarQube token (HTTP Basic with the token as username and empty password).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (token →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  SonarQube server; saving a connection registers `sonarqube-server` as a deploy
  target).

> SonarQube Web API paths and parameters follow the documented Web API
> (docs.sonarsource.com) and should be verified against your SonarQube version. TLS
> verification is off by default (self-signed tolerated) and configurable via the
> `verify_tls` setting.
>
> **Planned:** BYOL infrastructure hosting — provision and manage a SonarQube server
> (SonarQube + PostgreSQL) — ships in a later release, following the pattern used by
> the MISP app.
