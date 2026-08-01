# Changelog

All notable changes to the SonarQube app are documented here.

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
