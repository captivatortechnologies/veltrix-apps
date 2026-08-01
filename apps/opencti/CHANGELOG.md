# Changelog

All notable changes to the OpenCTI app are documented here.

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
