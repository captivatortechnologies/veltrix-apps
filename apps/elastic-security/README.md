# Elastic Security

Manage [Elastic Security](https://www.elastic.co/security) configuration as code through the Kibana
and Elasticsearch APIs. Author configurations in the platform's Configuration Canvas and deploy them
through the Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback
are handled per configuration type.

## Two endpoints, one credential

Elastic Security config spans two services, both authenticated by the same Elastic API key:

- **Kibana** — detection rules, exception lists, value lists, spaces, tags, timeline templates, Fleet package
  policies (`/api/...`)
- **Elasticsearch** — ILM policies, role mappings, roles, ingest pipelines, component templates, transforms, ML
  jobs (`/_ilm`, `/_security`, `/_ingest`, `/_component_template`, `/_transform`, `/_ml`)

## Credentials

Create an API key in Kibana under **Stack Management → API keys** and copy the **Base64** value (the
encoded `id:api_key` string). Store it as a Veltrix credential:

| Veltrix credential field | Elastic value |
| --- | --- |
| API token | The Base64 `id:api_key` value |

A username + password may be used instead for Basic auth. The key inherits privileges, so scope it to
what this app manages. Every request is sent as `Authorization: ApiKey <encoded>`; Kibana calls also
carry `kbn-xsrf: true` and `elastic-api-version: 2023-10-31`.

Register an **`elastic-deployment`** component whose hostname is the **Kibana** base URL (e.g.
`https://my-deployment.kb.us-central1.gcp.cloud.es.io:9243`) and attach the credential. Set the
**Elasticsearch URL** app setting (required for ILM policies and role mappings) and, optionally, a
**Kibana space** to scope space-aware config.

## What it manages

Configuration types are grouped in the sidebar: **Detections & Lists**, **Elasticsearch**,
**Machine Learning**, **Endpoint** and **Kibana**.

| Group | Configuration type | Object | Endpoint |
| --- | --- | --- | --- |
| Detections & Lists | Detection Rules | Security detection rules (query/EQL/threshold/ML/...) | Kibana `/api/detection_engine/rules` |
| Detections & Lists | Exception Lists | Exception lists + their items | Kibana `/api/exception_lists` |
| Detections & Lists | Value Lists | Value lists + their items (reusable IP/keyword/range sets) | Kibana `/api/lists` |
| Elasticsearch | ILM Policies | Index lifecycle policies (hot/warm/cold/delete) | Elasticsearch `/_ilm/policy` |
| Elasticsearch | Role Mappings | Role mappings (roles + a rules DSL) | Elasticsearch `/_security/role_mapping` |
| Elasticsearch | Roles | Security roles (cluster/index/application privileges) | Elasticsearch `/_security/role` |
| Elasticsearch | Ingest Pipelines | Processor-chain pipelines | Elasticsearch `/_ingest/pipeline` |
| Elasticsearch | Component Templates | Reusable mappings/settings/aliases | Elasticsearch `/_component_template` |
| Elasticsearch | Transforms | Pivot/latest aggregations into a destination index | Elasticsearch `/_transform` |
| Machine Learning | ML Anomaly Detection Jobs | Anomaly jobs + their datafeed | Elasticsearch `/_ml/anomaly_detectors`, `/_ml/datafeeds` |
| Endpoint | Fleet Package Policies | Integration policies, incl. Elastic Defend | Kibana `/api/fleet/package_policies` |
| Kibana | Spaces | Kibana spaces | Kibana `/api/spaces/space` |
| Kibana | Tags | Saved-object tags | Kibana `/api/tags` |
| Kibana | Timeline Templates | Reusable investigation timelines | Kibana `/api/timeline` |

## Elastic-specific behaviour the app handles

- **Identity keys survive environments.** Detection rules key on the stable user-defined `rule_id`
  (not the server UUID `id`); exception lists / value lists on their `list_id` / `id`; ILM policies,
  role mappings, roles, ingest pipelines and component templates on their name; transforms and ML
  jobs on their id; spaces on `id` (immutable); tags on a caller-chosen `id`; timeline templates on
  the portable `templateTimelineId`; Fleet package policies have no caller-chosen identity (Fleet
  assigns the internal id), so that type reconciles by **name** instead — list, match, then update or
  create, the same shape Cisco Meraki's group-policies config type uses for a vendor-assigned id.
  ILM policies, role mappings, roles, ingest pipelines, component templates and tags are true
  upserts; the Kibana saved-object types (detection rules, exception/value lists, spaces, Fleet
  policies, timeline templates) use list-then-create-or-update (no native upsert).
- **Immutable-after-creation fields, never silently dropped.** For custom detection rules, `version`
  is set once at creation and never incremented (the app never writes it on update — the field that
  increments, `revision`, is server-managed). A value list's `type`, a transform's `pivot`/`latest`
  aggregation, and an ML job's `analysis_config`/`data_description` are likewise immutable once
  created — Elasticsearch's own update endpoints reject or silently ignore them, so this app never
  sends them on update, and drift detection reports a mismatch (with a note that it can only be fixed
  by delete + recreate) rather than pretending the field converged.
- **Enabled-driven runtime toggles.** Transforms are created stopped and ML jobs are created closed
  with a stopped datafeed — Elasticsearch has no "enabled" field on either, so the canvas's Enabled
  checkbox drives an explicit start/stop (transforms) or open+start/stop+close (ML jobs, in the
  correct order — a datafeed can only start once its job is open, and must stop before its job can
  close) on every deploy, converged idempotently.
- **Managed objects are never touched**: Elastic-managed prebuilt detection rules
  (`immutable: true` / `rule_source.type: external`), managed ILM policies / ingest pipelines /
  component templates (`_meta.managed: true`, or dot/`@`-prefixed and Elastic's built-in
  logs-*/metrics-*/synthetics-* template names), reserved role mappings and roles
  (`metadata._reserved: true`), and the `default` Kibana space — update-in-place only where allowed,
  never modified/deleted.
- The large, type-dependent parts (the rule body, ILM phases, exception/value-list entries, the
  role-mapping rules DSL, a role's index/application privileges, a pipeline's processors, a component
  template's mappings/settings, a transform's aggregation, an ML job's analysis config, a Fleet
  package policy's inputs, a timeline template's data providers/filters/columns) are authored as JSON
  in the canvas.

## Health check

Handlers make a cheap read against the relevant service (a paged rule/space fetch for Kibana types, a
policy list for Elasticsearch types) to prove the credential works before doing any work.

## References

- Security APIs: <https://www.elastic.co/guide/en/security/current/security-apis.html>
- ILM: <https://www.elastic.co/guide/en/elasticsearch/reference/current/ilm-put-lifecycle.html>
- Lists API (OpenAPI): <https://www.elastic.co/docs/api/doc/kibana/group/endpoint-security-lists-api>
- Security role API: <https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-put-role.html>
- Ingest pipelines: <https://www.elastic.co/guide/en/elasticsearch/reference/current/put-pipeline-api.html>
- Component templates: <https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-component-template.html>
- Transform APIs: <https://www.elastic.co/guide/en/elasticsearch/reference/current/transform-apis.html>
- ML anomaly detection jobs: <https://www.elastic.co/guide/en/elasticsearch/reference/current/ml-put-job.html>
- Fleet API (package policies): <https://www.elastic.co/guide/en/fleet/current/fleet-api-docs.html>
- Tags API (OpenAPI): <https://www.elastic.co/docs/api/doc/kibana/group/endpoint-tags>
- Security Timeline API (OpenAPI bundle, `security_solution_timeline_api_2023_10_31`, elastic/kibana source)

## Development

```
cd apps/elastic-security
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs elastic-security      # run handler tests
node ../../scripts/validate-app.mjs apps/elastic-security  # validate against the app contract
```

## Coverage (v1.3.0)

Coverage was audited against Elastic's official REST API references — the Kibana OpenAPI docs
(`elastic.co/docs/api/doc/kibana`), the Elasticsearch Guide (`elastic.co/guide/en/elasticsearch/reference/current`)
and, where the public docs prose was ambiguous (the Lists API's `id`-optionality on create, the
Security Timeline API's exact `PATCH`/`GET` contract), the corresponding request/response schemas in
the `elastic/kibana` source (`x-pack/solutions/security/plugins/{lists,security_solution}`,
`x-pack/platform/plugins/shared/{saved_objects_tagging,fleet}`) — on 2026-08-04.

### Managed declarative configuration

| Configuration type | API operations |
| --- | --- |
| Detection rules | list/create/update `/api/detection_engine/rules`, keyed by `rule_id` |
| Exception lists + items | list/create/update/delete `/api/exception_lists[/items]`, keyed by `list_id` / `item_id` |
| Value lists + items | list/create/update/delete `/api/lists[/items]`, keyed by `id` |
| ILM policies | `GET`/`PUT` `/_ilm/policy/{name}` (upsert) |
| Role mappings | `GET`/`PUT` `/_security/role_mapping/{name}` (upsert) |
| Roles | `GET`/`PUT` `/_security/role/{name}` (upsert) |
| Ingest pipelines | `GET`/`PUT` `/_ingest/pipeline/{id}` (upsert) |
| Component templates | `GET`/`PUT` `/_component_template/{name}` (upsert) |
| Transforms | `PUT` (create) / `POST .../_update` (update, mutable subset) `/_transform/{id}`, `_start`/`_stop` |
| ML anomaly detection jobs + datafeeds | `PUT` (create) / `POST .../_update` (update) `/_ml/anomaly_detectors/{id}` and `/_ml/datafeeds/{id}`, `_open`/`_close`/`_start`/`_stop` |
| Fleet package policies (incl. Elastic Defend) | list/create/update `/api/fleet/package_policies[/{id}]`, reconciled by name |
| Kibana spaces | list/create/update `/api/spaces/space[/{id}]`, keyed by immutable `id`; `default` protected |
| Tags | `GET`/`PUT` `/api/tags/{id}` (upsert) |
| Timeline templates | `GET`/`POST`/`PATCH`/`DELETE` `/api/timeline`, keyed by the portable `templateTimelineId` |

Every immutable-after-creation field (custom-rule `version`, a value list's `type`, a transform's
`pivot`/`latest`, an ML job's `analysis_config`/`data_description`) is never re-sent on update and any
drift in it is reported rather than silently ignored. Every managed/reserved/built-in object
(prebuilt detection rules, `_meta.managed` ILM policies/pipelines/component templates, `metadata._reserved`
role mappings and roles, the default Kibana space, Elastic's built-in `logs-*`/`metrics-*`/`synthetics-*`
component templates) is protected from authoring or modification.

### Intentionally excluded

- **Rule actions / connectors** (Kibana `/api/actions/connector`) — a connector's `secrets` object
  (API keys, webhook tokens, SMTP credentials) is **write-only and never returned on read**. Modeling
  it here would mean plaintext credential material sitting in canvas JSON and version history outside
  the Credential Vault, and neither drift detection nor rollback can ever reconcile a field the API
  will not echo back. This app manages exactly one credential (the Elastic API key) deliberately, to
  avoid becoming a second, weaker secrets store — connectors are the config type where that trade-off
  is unavoidable, so they are dropped rather than modeled unsafely. A rule's own `actions` array
  (referencing a connector by id) still passes through untouched as part of `ruleJson`.
- **Ad-hoc analyst timelines** (`timelineType: "default"`) are per-analyst investigative work product
  — closer to alert/case data than configuration — so only reusable **timeline templates** are
  managed. Notes and pinned events (`/api/note`, `/api/pinned_event`) are per-investigation annotations
  on those ad-hoc timelines and are excluded for the same reason.
- **Composable index templates** (`/_index_template`) reference the component templates this app
  already manages but are not themselves built in this release — a reasonable, scoped follow-on.
- **Detection-rule prebuilt content management** (installing/upgrading Elastic's shipped rule
  packages via `/api/detection_engine/rules/prepackaged`) is a one-time content installation action,
  not a piece of durable, user-authored desired state.
- **Alerts/signals, ML anomaly results, transform/ILM execution stats, and any other per-document
  runtime/output data** are generated at runtime by rules/jobs/transforms already managed here — never
  authored, so never modeled as a separate configuration type.
- Kibana's remaining saved-object families outside the Security Solution (dashboards, visualizations,
  Lens, Maps, alerting rules for other solutions, index patterns/data views not owned by Fleet) are
  outside this app's Security-focused scope.

Primary references: see [References](#references) above; each endpoint is also cited at the top of
its config type's `deploy.ts`.
