# Changelog

All notable changes to the Elastic Security app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-04

### Added
- **Nine new configuration types**, exhausting the rest of the genuinely
  declarative Kibana Security + Elasticsearch config surface (research-first,
  each verified against Elastic's official REST API docs / OpenAPI specs
  before being modeled — see the README **Coverage** section for exact
  operations and sources):
  - **Value Lists** (`value-lists`) — Kibana Lists API value lists (reusable
    IP/keyword/range value sets referenced by exception-item "is in list"
    entries) and their items. Same container+folded-items shape as Exception
    Lists; `type` is immutable after creation.
  - **Roles** (`roles`) — Elasticsearch security roles (cluster/index/
    application privileges, run_as). True upsert by name; reserved/built-in
    roles (`metadata._reserved`) protected, the same convention Role Mappings
    already uses.
  - **Ingest Pipelines** (`ingest-pipelines`) — Elasticsearch ingest pipelines
    (processor chains). True upsert by id; dot-prefixed Elastic-managed
    pipelines protected, "@"-suffixed (Fleet-integration-owned) ids warned.
  - **Component Templates** (`component-templates`) — Elasticsearch component
    templates (reusable mappings/settings/aliases building blocks). True
    upsert by name; Elastic's built-in logs-*/metrics-*/synthetics-* templates
    and dot/@-prefixed names protected.
  - **Transforms** (`transforms`) — Elasticsearch transforms (pivot/latest
    aggregations from a source index to a destination index). Create-then-
    update (the pivot/latest aggregation is immutable after creation — the
    `_update` endpoint does not accept it); the Enabled toggle drives
    start/stop.
  - **ML Anomaly Detection Jobs** (`ml-jobs`) — Elasticsearch machine-learning
    jobs plus their datafeed. `analysis_config` / `data_description` are
    immutable after creation; the Enabled toggle drives open/close (job) and
    start/stop (datafeed) in the correct order. Requires an ML-enabled
    subscription/trial.
  - **Fleet Package Policies** (`fleet-package-policies`) — Fleet integration
    (package) policies, including **Elastic Defend** endpoint protection
    policies. Fleet assigns the internal id on create, so this reconciles by
    name (the same shape Cisco Meraki's group-policies config type uses for a
    Meraki-assigned id).
  - **Tags** (`tags`) — Kibana saved-object tags. True upsert by a
    caller-chosen id (`PUT /api/tags/{id}` — documented as "Upsert a tag"),
    unlike `POST /api/tags` which server-generates one.
  - **Timeline Templates** (`timeline-templates`) — Elastic Security
    investigation timeline templates, keyed by the portable
    `templateTimelineId` (the same field Elastic's own prepackaged templates
    use for cross-environment identity). Ad-hoc analyst timelines are
    deliberately excluded — see Coverage.
- **Configuration types are now grouped** in the sidebar (`group:` on every
  `pipeline.configurationTypes` entry, including the five pre-existing types):
  **Detections & Lists**, **Elasticsearch**, **Machine Learning**,
  **Endpoint**, **Kibana**.
- Drift attribution (`config-types/lib/elasticAudit.ts`) is wired for every
  new type whose live object carries a modifier: **Value Lists** (list +
  items, `updated_by`/`created_by`), **Fleet Package Policies**
  (`updated_by`/`updated_at`) and **Timeline Templates** (Kibana's
  camelCase `updatedBy`/`updated`, adapted into the shared helper's shape).
  **Roles**, **Ingest Pipelines**, **Component Templates**, **Transforms**,
  **ML Jobs** and **Tags** expose no per-object modifier through their APIs
  and are unattributed by design — the same honest treatment already applied
  to ILM policies, role mappings and spaces.

### Intentionally not added (see README Coverage for the full list and reasons)
- **Rule actions / connectors** (Kibana Actions/Connectors API) — a
  connector's `secrets` object (API keys, webhook tokens, SMTP passwords) is
  write-only and never returned on read. Authoring it here would mean
  plaintext credential material sitting in canvas JSON outside the Credential
  Vault, and drift/rollback can never reconcile a field Kibana will not echo
  back — this is exactly the "secret material" this app's own Elastic API-key
  design was built to avoid duplicating.
- Detection rule exception lists + items were **already fully covered** by the
  existing `exception-lists` type (container + folded items, reconciled by
  `item_id`) — verified, not re-built.

## 1.2.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Elastic object, each reported difference is now annotated with the
  person who made the last change and when. The platform stores the `actor` on
  each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - Attribution reads the modifier Kibana records DIRECTLY on the drifted object
    — `updated_by` / `updated_at` (the last writer, preferred), with
    `created_by` / `created_at` as a fallback — which the drift check already
    fetches. This is the most reliable actor source (the object's own record of
    its last writer) and needs no extra API call, scope or audit-log query.
  - Applies to the config types whose objects carry a modifier: **detection
    rules** (per rule) and **exception lists** (the list container and each item
    are attributed independently to their own last writer).
  - An email-shaped principal (SSO) is surfaced as the actor's email; a bare
    username is surfaced as the actor id. The raw value is always kept as the
    display name.
  - Veltrix's own deploys are recorded under the connection's login, so a change
    WE made is excluded via that login — the attribution reflects the *manual*
    change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, or when an object carries no usable modifier (a deleted
    object, or an object with none recorded), the diff is reported without an
    actor and the drift view shows "—". Only objects that actually drifted are
    attributed (one resolution per drifted object).
  - **Unattributed by design:** Elasticsearch ILM policies, Elasticsearch role
    mappings and Kibana spaces expose no per-object modifier (and no per-object
    audit trail through this app's API), so their drift is reported without an
    actor. The attribution is still wired uniformly, so it will surface a modifier
    automatically if Elastic ever records one — it is never fabricated.
