# Changelog

All notable changes to the OpenCTI app are documented here.

## 0.4.0 — 2026-08-04

Exhausted the OpenCTI GraphQL config-as-code surface against the actual OpenCTI
backend schema source (`opencti-platform/opencti`, `config/schema/opencti.graphql`
+ `src/modules/**/*.graphql`) — thirteen new configuration types, plus
correctness fixes to all four previously-shipped types once the real schema
contradicted their earlier "follow OpenCTI conventions, verify against a live
instance" guesses.

**Correctness fixes to existing types** (all four had at least one real,
schema-verified bug):
- **Marking Definitions** / **Labels**: `markingDefinitionFieldPatch` /
  `markingDefinitionDelete` and `labelFieldPatch` / `labelDelete` do not exist —
  both are nested editor mutations, `markingDefinitionEdit(id) { fieldPatch /
  delete }` and `labelEdit(id) { fieldPatch / delete }`. Also,
  `MarkingDefinitionAddInput.x_opencti_order` is REQUIRED — now always sent
  (defaulted to 0).
- **Groups**: `groupDelete(id)` does not exist as a top-level mutation — delete
  is `groupEdit(id) { delete }` (fieldPatch was already correctly nested).
  `GroupAddInput` REQUIRES `group_confidence_level: ConfidenceLevelInput!` —
  every `groupAdd` was failing schema validation; added an optional "Max
  Confidence Level" canvas field, always sent (with an empty per-entity-type
  `overrides` list, out of scope).
- **Ingestion Feeds (TAXII2)**: `TaxiiVersion` is `v1 | v2 | v21` — the shipped
  `"v20"` option does not exist (the real pre-2.1 value is `"v2"`); added the
  missing `"v1"` option too. `IngestionTaxiiAddInput` REQUIRES `user_id:
  String!` (the OpenCTI user ingested data is attributed to) — every create
  was failing schema validation; added a required "OpenCTI User ID" canvas
  field.
- **All four**: `EditInput.value` is `[Any]!` in the real schema, not
  `[String]!` — field patches now send native booleans/numbers instead of
  stringifying them (`buildXxxPatch` and `EditInput` interfaces updated,
  cross-checked against pycti, which never stringifies these values either).

**Thirteen new configuration types**, each with the full pipeline (validate /
deploy / rollback / health-check / drift-detect / status), grouped in the
Configuration Canvas:

- **Data Management**: **Kill Chain Phases** (`killChainPhaseAdd` /
  `killChainPhaseEdit`), **Vocabularies** (open-vocabulary entries across all
  ~48 `VocabularyCategory` values; `vocabularyAdd` / `vocabularyFieldPatch` /
  `vocabularyDelete`), **Status Templates** (name + color library;
  `statusTemplateAdd` / `statusTemplateFieldPatch` / `statusTemplateDelete`).
- **Access Control**: **Roles** (name + description; `roleAdd` /
  `roleEdit`) — capability assignment is a documented follow-up.
- **Case Management**: **Case Templates** and **Case Task Templates**
  (`caseTemplateAdd` / `caseTemplateFieldPatch` / `caseTemplateDelete`,
  `taskTemplateAdd` / `taskTemplateFieldPatch` / `taskTemplateDelete`) — a
  case template's `task_template_names` are resolved to Case Task Template ids
  at deploy time by name.
- **Notifications**: **Notifiers** and **Notification Triggers** (Live
  knowledge triggers only; `notifierAdd` / `notifierFieldPatch` /
  `notifierDelete`, `triggerKnowledgeLiveAdd` / `triggerKnowledgeFieldPatch` /
  `triggerKnowledgeDelete`) — a trigger's `notifier_names` are resolved to
  Notifier ids at deploy time by name. Digest and Activity triggers are
  documented as excluded (bigger, separate surfaces).
- **Platform Administration**: **Retention Rules** (`retentionRuleAdd` /
  `retentionRuleEdit`) and **Entity Settings** — the latter has a UNIQUE shape:
  OpenCTI seeds one EntitySetting singleton per entity type at install, so
  this type only ever field-patches an existing one via
  `entitySettingsFieldPatch`; there is no create or delete.
- **Data Sharing**: **Stream Collections**, **TAXII Collections**
  (`streamCollectionAdd` / `streamCollectionEdit`, `taxiiCollectionAdd` /
  `taxiiCollectionEdit`) and **Feeds** (rolling CSV/TAXII export;
  `feedAdd` / `feedEdit` / `feedDelete`) — Feeds is also uniquely shaped:
  `feedEdit(id, input: FeedAddInput!)` replaces the WHOLE object rather than
  patching a field list, so this type preserves any live
  `feed_public_user_id`/`authorized_members` it doesn't itself manage instead
  of silently clearing them on every deploy.

**Intentionally excluded** (see README Coverage for the full list + reasons):
Connectors (no admin-authorable create path — connectors self-register),
Playbooks (no atomic whole-graph-declare mutation, only N imperative node/link
calls against a mutable graph), RSS/CSV/JSON ingestion feeds (real, deferred to
a future release), per-subtype Status Workflows and the newer FSM Workflow
Definitions engine (both real and declarative, but materially bigger
cross-referencing surfaces deserving their own pass), and all runtime/read-only
surfaces (connector health, work status, audit logs, playbook executions).

> All new operations were verified directly against the OpenCTI backend
> GraphQL schema source (cloned 2026-08-04) rather than inferred from
> conventions — see README Coverage for citations. A handful of narrower
> specifics remain honestly flagged in-code where the schema alone doesn't
> settle them (e.g. whether `tasks`/`notifiers` accept a plain `EditInput`
> patch on an existing case template/trigger).

## 0.3.0 — 2026-08-01

BYOL infrastructure hosting — provision and manage a dedicated OpenCTI stack
(bring-your-own-license) from an **Infrastructure** console, then run its
lifecycle. Adapted from the MISP BYOL subsystem, but **node_tiers-native**: the
per-tier node counts + placement are stored ONLY in a `node_tiers` JSONB column
(no legacy indexer/search-head columns).

- **Three user-scalable node tiers** — Platform nodes (OpenCTI GraphQL/web),
  Ingest workers, and Search nodes (Elasticsearch / OpenSearch). A distributed
  search tier requires ≥3 nodes for a real cluster (enforced server-side); the
  platform tier is ALB-fronted (OpenCTI web/GraphQL on 4000).
- **Fixed supporting services** added to every distributed plan automatically —
  Redis (cache / sessions / stream), RabbitMQ (worker broker) and MinIO / S3
  object storage — plus the foundation (network, load balancer, DNS, TLS,
  secrets).
- **Declarative `infra/spec.ts`** — composes the same generic OpenTofu modules as
  the other BYOL apps by declaring OpenCTI's ports/roles + an S3 object-storage
  bucket. No tool-specific HCL.
- **`/byol` routes** — list / get / create / update / delete / plan / deploy /
  destroy / start-stop-restart / resources / deployments, plus usage metering
  (`/byol/usage`, `/byol/usage/collect`). Terraform-style plan diff, canonical
  tenant/cost tags and a per-stack subnet reservation on deploy.
- **App-owned schema** (`opencti_`-prefixed) — infrastructure + resource plan +
  deployment runs/steps (migration 002) and the state-event + daily usage ledger
  for node-hours billing (migration 003).
- **Permissions** — new `byol` (read/write/delete) and `usage` (read/write) app
  resources.

> Stack sizing / ports are a reasonable default — **verify against current
> OpenCTI deployment guidance** (docs.opencti.io) before treating them as
> production-grade. The ALB health-check path (`/`) and the search-tier minimum
> (≥3) are flagged in-code.

## 0.2.0 — 2026-08-01

Three more configuration types, each with the full pipeline (validate / deploy /
rollback / health-check / drift-detect / status) over the OpenCTI GraphQL API.

- **Labels** config type — add / edit / delete OpenCTI labels (value, color).
  Upsert by the `value`. GraphQL: `labels` / `labelAdd` / `labelFieldPatch` /
  `labelDelete`.
- **Groups** config type — add / edit / delete OpenCTI RBAC groups (name,
  description, `default_assignation`, `auto_new_marking`). Upsert by `name`.
  GraphQL: `groups` / `groupAdd` / `groupEdit(id){ fieldPatch }` / `groupDelete`.
- **Ingestion Feeds (TAXII2)** config type — add / edit / delete OpenCTI TAXII2
  feeds (name, uri, collection, version, authentication type + write-only value,
  optional import-from date). Upsert by `name`. GraphQL: `ingestionTaxiis` /
  `ingestionTaxiiAdd` / `ingestionTaxiiEdit` / `ingestionTaxiiDelete`.

> **Verify against a live OpenCTI instance.** The new operation + field names
> follow OpenCTI conventions but are unverified — flagged in-code. In particular:
> the group edit shape (`groupEdit(id){ fieldPatch }` vs a top-level
> `groupFieldPatch`) and delete (`groupDelete` vs `groupEdit(id){ delete }`); the
> TAXII list field (`ingestionTaxiis` vs `ingestionTaxiiConnections`) and the
> `IngestionTaxiiAddInput` field names; the group `auto_new_marking` selection; and
> the `EditInput` value-as-string-list shape (booleans sent as `"true"`/`"false"`).

## 0.1.0 — 2026-07-31

Initial release — foundation + first config type.

- **Marking Definitions** config type — add / edit / delete OpenCTI data-marking
  definitions (type, definition, color, order) over the OpenCTI GraphQL API, with
  validate / deploy (upsert by the `definition` value) / rollback (restore prior or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the OpenCTI GraphQL API (`about { version }`,
  fallback `me { id name }`, HTTPS, self-signed tolerated) using an OpenCTI API
  token carried as a Bearer token.
- **GraphQL seam** (`lib/openctiApi.ts`) — a self-signed-tolerant `node:https`
  client with a `graphql(query, variables)` helper and a version/connectivity probe.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API token →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for an
  OpenCTI instance; saving a connection registers `opencti-platform` as a deploy
  target).

> OpenCTI GraphQL operation + field names follow OpenCTI conventions and should be
> verified against a live OpenCTI instance (the `about { version }` probe, the
> `EditInput` value-as-string-list patch shape, and `MarkingDefinitionAddInput`
> fields). TLS verification is off by default (self-signed) and configurable via the
> `verify_tls` setting.
