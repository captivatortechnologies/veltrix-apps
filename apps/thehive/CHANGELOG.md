# Changelog

All notable changes to the TheHive app are documented here.

## 0.4.0 — 2026-08-04

Three new config types, exhausting the standalone declarative admin surface of
TheHive's REST API alongside the existing case-templates / custom-fields /
observable-types / users pipeline. See README **Coverage** for the full
accounting of what's managed vs. deliberately excluded.

- **Organisations** config type — add / edit TheHive organisations (multi-tenant
  containers for cases/alerts): name, description, task/observable sharing
  rules (`manual` / `autoShare`) and locked state, over `/api/v1/organisation`
  (create `POST`, update `PATCH`, list via the query API). **TheHive has no
  delete endpoint for organisations on either version** — deploy is
  create/update-only, and rolling back a *created* organisation locks it
  (the only safe, available undo) rather than deleting it.
- **Profiles** config type — add / edit / delete TheHive profiles (RBAC roles):
  name and a free-text permission list, over `/api/v1/profile` (full CRUD).
  Upsert by **name**; rollback restores the prior permission set or deletes a
  created profile. TheHive's permission catalog is version-dependent and not
  exhaustively published anywhere public, so `permissions` is free text rather
  than a hardcoded enum; validate.ts warns when a name matches one of TheHive's
  five immutable built-in profiles (everything but `analyst`).
- **Page Templates** config type — add / edit / delete TheHive page templates
  (Knowledge Base): title, category, content and sort order, over
  `/api/v1/pageTemplate` (full CRUD). **TheHive 5 only** — confirmed absent
  from the TheHive 4 OpenAPI spec, so this bypasses the `THEHIVE_PATHS` v4/v5
  seam entirely (`PAGE_TEMPLATE_PATHS_V5` / `isPageTemplateSupported()` in
  `lib/thehiveApi.ts`) and deploy fails fast with a clear message rather than
  guessing a v4 path.
- **v4/v5 seam additions** — organisations share the SAME `/api/v1/organisation`
  create/update path on both versions (list differs: v5 query API vs v4's
  legacy `/api/v0/organisation` collection GET); profiles differ by VERSION
  (`/api/v1/profile` on v5, `/api/v0/profile` on v4) — both confirmed via the
  official TheHive 4 OpenAPI spec (`github.com/TheHive-Project/api-docs`),
  not flagged as unverified like the v0.2.0 additions.
- **Honest drops, researched and cited** (see README Coverage) — custom
  case/alert statuses (real feature, confirmed via StrangeBee's admin docs, but
  UI-only per those same docs and absent from `thehive4py`/the OpenAPI spec —
  no verifiable endpoint to build against), taxonomies/tags (MISP-catalog
  activate/deactivate model, not an authored list), analyzer templates
  (Cortex report-rendering ZIP import, UI-only), dashboards (no authoring API
  found anywhere), and "impact statuses" (not a concept that exists in
  TheHive's documented status or observable model).

> **Verify against a live TheHive (v4 vs v5).** Organisation and profile paths
> are corroborated by the archived TheHive 4 OpenAPI spec in addition to
> `thehive4py`; profile **permission strings** are not exhaustively documented
> anywhere public — read the live catalog from your instance's Profiles →
> "Add or Remove Permissions" screen before authoring one.

## 0.3.0 — 2026-08-01

**BYOL infrastructure hosting** — provision and manage a dedicated, self-managed
TheHive 5 stack (bring-your-own-license) from the new **Infrastructure** page,
alongside the existing configuration-as-code pipeline.

- **Stack topology (node_tiers-native).** Three user-scalable node tiers — the
  TheHive **application** (web/API, the ALB target on port 9000), the **Cassandra**
  data store, and the **Elasticsearch** search index — plus a fixed
  **MinIO / S3** object store for file attachments and the foundation (network,
  load balancer, DNS, TLS, secrets). A **single** deployment collapses to one
  all-in-one node (TheHive + Cassandra + Elasticsearch + MinIO); a **distributed**
  deployment expands every tier. Per-tier node counts + cluster placement live
  only in a `node_tiers` JSONB column (there are no legacy indexer/search-head
  count columns). A distributed Cassandra ring and Elasticsearch cluster each
  require **≥3 nodes** for a real HA quorum (enforced server-side).
- **Deployment console.** The SDK `<ByolInfrastructureManager>` over the app-owned
  `/byol` routes: create/edit stacks, a Terraform-style **plan** (add / change /
  destroy) enriched with the reserved subnet + canonical tenant/cost tags, an
  **apply** that seeds the resource plan and opens a tracked deployment run with
  ordered steps, plus start / stop / restart / destroy lifecycle actions.
- **Declarative provisioning foundation.** `infra/spec.ts` declares the TheHive 5
  stack (security rules, HTTP ALB on 9000 with a `/api/v1/status` health check,
  S3 object storage, WAF) against the SAME generic OpenTofu modules used by the
  other BYOL apps — no tool-specific HCL.
- **Usage metering.** App-owned lifecycle state-event log + a daily node-hours
  ledger (idempotent collector) as the foundation for usage-based cloud billing.
- **Database.** Two app-owned, `thehive_`-prefixed migrations — `002_thehive_byol`
  (infrastructure, resources, deployments, steps) and `003_thehive_byol_usage`
  (state events + usage ledger).

> **Verify against a live TheHive 5 deployment.** The stack roles/ports (Cassandra
> 9042, Elasticsearch 9200/9300, MinIO 9100, TheHive 9000) and HA sizing are
> reasonable defaults derived from the TheHive 5 operations guidance; confirm them
> against your target environment before treating them as production-grade.

## 0.2.0 — 2026-08-01

Three new organisation-configuration types, all over the TheHive REST API with
the same validate / deploy / rollback / health-check / drift-detect / status
pipeline and the shared `lib/thehiveApi.ts` v4/v5 seam.

- **Custom Fields** config type — add / edit / delete TheHive custom fields
  (name, display name, group, description, data type, mandatory flag, and
  enumeration options) over `/api/v1/customField` (create `POST`, update
  `PATCH`, delete `DELETE`, list `GET`). Upsert by field **name**; rollback
  restores the prior body or deletes a created field.
- **Observable Types** config type — add TheHive observable (datatype) types
  (name, file-attachment flag) over `/api/v1/observable/type`. TheHive 5 exposes
  no update endpoint, so this is a **create-if-missing** upsert: existing types
  are left untouched (an `isAttachment` mismatch is surfaced by drift, not
  corrected) and rollback deletes only the types the deploy created.
- **Users** config type — add / edit / delete TheHive users (login identity,
  display name, email, profile/role, organisation) over `/api/v1/user` (create
  `POST`, update `PATCH`, delete `DELETE /{id}/force`, list via the query API).
  Upsert by **login**; rollback restores the prior name/profile/org or deletes a
  created user. Passwords and API keys are intentionally **not** managed here.

> **Verify against a live TheHive (v4 vs v5).** New endpoint paths and input
> shapes are derived from the official TheHive 5 API and the maintained
> `thehive4py` client. Two nuances are flagged in the code: TheHive 5 custom
> fields have **no `enumeration` type** (use a base type + `options`, and the
> client's type list includes `url`); and observable types have **no update
> endpoint**. TheHive 4 paths for all three are the flagged single-seam
> alternate in `lib/thehiveApi.ts`.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Case Templates** config type — add / edit / delete TheHive case templates
  (name, display name, title prefix, severity, TLP, PAP, tags, description, and
  prefilled tasks) over the TheHive REST API, with validate / deploy (upsert by
  template name) / rollback (restore prior or delete created) / health-check /
  drift-detect / status.
- **Connectivity test** against the TheHive REST API (`GET /api/v1/user/current`,
  Bearer API key, self-signed tolerated).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  TheHive instance; saving a connection registers `thehive` as a deploy target).

> **TheHive 4 vs 5 caveat.** The primary target is **TheHive 5** (StrangeBee,
> `/api/v1/caseTemplate`, listed via `POST /api/v1/query`). **TheHive 4**
> (`/api/case/template` + `/_search`) is a flagged single-seam alternate in
> `lib/thehiveApi.ts` (`API_VERSION`). API paths and case-template field shapes
> should be **verified against a live TheHive** (note v4 vs v5). TLS verification
> is off by default (self-signed) and configurable via the `verify_tls` setting.

> **BYOL planned.** Hosting a self-managed TheHive stack (BYOL infrastructure
> provisioning + database) is planned for a later wave and is intentionally not
> part of this foundation.
