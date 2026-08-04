# 🔭 OpenCTI

Manage [OpenCTI](https://filigran.io/solutions/open-cti/) — the open-source cyber
threat-intelligence platform — as code on the Veltrix Security-as-Code platform.
Author threat-intel configuration in the Configuration Canvas and drive it through
the pipeline (validate → deploy → rollback → health-check → drift-detect → status).

## How it's managed

OpenCTI exposes a single **GraphQL API** over HTTPS. This app applies configuration
over that API:

- **HTTPS GraphQL** — `POST /graphql`. Authentication is your OpenCTI **API token**
  (Profile → API access) carried as a **Bearer token** in the `Authorization`
  header, stored as the connection credential's API token. Self-hosted OpenCTI
  commonly ships a **self-signed certificate**, which the transport tolerates.

## Configuration types

| Group | Type | Surface | Status |
|---|---|---|---|
| Data Management | **Marking Definitions** | `markingDefinitions` / `markingDefinitionAdd` / `markingDefinitionEdit{fieldPatch/delete}` | ✅ v0.1.0 (fixed v0.4.0) |
| Data Management | **Labels** | `labels` / `labelAdd` / `labelEdit{fieldPatch/delete}` | ✅ v0.2.0 (fixed v0.4.0) |
| Data Management | **Kill Chain Phases** | `killChainPhases` / `killChainPhaseAdd` / `killChainPhaseEdit{fieldPatch/delete}` | ✅ v0.4.0 |
| Data Management | **Vocabularies** | `vocabularies` / `vocabularyAdd` / `vocabularyFieldPatch` / `vocabularyDelete` | ✅ v0.4.0 |
| Data Management | **Status Templates** | `statusTemplates` / `statusTemplateAdd` / `statusTemplateFieldPatch` / `statusTemplateDelete` | ✅ v0.4.0 |
| Access Control | **Groups** | `groups` / `groupAdd` / `groupEdit{fieldPatch/delete}` | ✅ v0.2.0 (fixed v0.4.0) |
| Access Control | **Roles** | `roles` / `roleAdd` / `roleEdit{fieldPatch/delete}` | ✅ v0.4.0 |
| Case Management | **Case Templates** | `caseTemplates` / `caseTemplateAdd` / `caseTemplateFieldPatch` / `caseTemplateDelete` | ✅ v0.4.0 |
| Case Management | **Case Task Templates** | `taskTemplates` / `taskTemplateAdd` / `taskTemplateFieldPatch` / `taskTemplateDelete` | ✅ v0.4.0 |
| Notifications | **Notifiers** | `notifiers` / `notifierAdd` / `notifierFieldPatch` / `notifierDelete` | ✅ v0.4.0 |
| Notifications | **Notification Triggers** | `triggers` / `triggerKnowledgeLiveAdd` / `triggerKnowledgeFieldPatch` / `triggerKnowledgeDelete` | ✅ v0.4.0 |
| Platform Administration | **Retention Rules** | `retentionRules` / `retentionRuleAdd` / `retentionRuleEdit{fieldPatch/delete}` | ✅ v0.4.0 |
| Platform Administration | **Entity Settings** | `entitySettingByType` / `entitySettingsFieldPatch` (patch-only) | ✅ v0.4.0 |
| Data Sharing | **Stream Collections** | `streamCollections` / `streamCollectionAdd` / `streamCollectionEdit{fieldPatch/delete}` | ✅ v0.4.0 |
| Data Sharing | **TAXII Collections** | `taxiiCollections` / `taxiiCollectionAdd` / `taxiiCollectionEdit{fieldPatch/delete}` | ✅ v0.4.0 |
| Data Sharing | **Feeds** | `feeds` / `feedAdd` / `feedEdit` (whole-object) / `feedDelete` | ✅ v0.4.0 |
| Threat Intelligence | **Ingestion Feeds (TAXII2)** | `ingestionTaxiis` / `ingestionTaxiiAdd` / `ingestionTaxiiFieldPatch` / `ingestionTaxiiDelete` | ✅ v0.2.0 (fixed v0.4.0) |

See [Coverage](#coverage-v040) below for what's intentionally excluded and why.

Each config type upserts by a stable identity — the marking `definition` (e.g.
`TLP:AMBER`), the label `value`, the group/role/case-template/notifier/trigger
`name`, the vocabulary `category`+`name`, the kill-chain-phase `kill_chain_name`+
`phase_name`, the entity-setting `target_type` — used to choose add vs field-patch
(or, for Entity Settings, the only operation there is) and to detect drift; deploy
snapshots the prior node so rollback can restore it (or delete an object it
created).

## GraphQL operations

All operations run against `POST <base>/graphql` with `Authorization: Bearer <token>`.
Every `EditInput` is `{ key, object_path?, value: [Any], operation? }` — `value` is
sent as **native JSON types** (booleans/numbers are NOT stringified); an
object/array-valued attribute is patched with `value` set to that single object, or
to the full replacement array, respectively.

**Connectivity / health:** `query { about { version } }` (fallback `query { me { id name } }`)

**Marking Definitions**
- **List:** `markingDefinitions { edges { node { id standard_id definition definition_type x_opencti_color x_opencti_order } } }`
- **Create:** `markingDefinitionAdd(input: MarkingDefinitionAddInput!)` — input `{ definition_type, definition, x_opencti_order (required, default 0), x_opencti_color? }`
- **Update/Delete:** `markingDefinitionEdit(id: ID!) { fieldPatch(input: [EditInput!]!) / delete }`

**Labels**
- **List:** `labels { edges { node { id value color } } }`
- **Create:** `labelAdd(input: LabelAddInput!)` — input `{ value, color? }`
- **Update/Delete:** `labelEdit(id: ID!) { fieldPatch(input: [EditInput!]!) / delete }`

**Kill Chain Phases**
- **List:** `killChainPhases { edges { node { id kill_chain_name phase_name x_opencti_order } } }`
- **Create:** `killChainPhaseAdd(input: KillChainPhaseAddInput!)` — input `{ kill_chain_name, phase_name, x_opencti_order (required, default 0) }`
- **Update/Delete:** `killChainPhaseEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }`
- Identity is compound (`kill_chain_name` + `phase_name`) — two kill chains can share a phase name.

**Vocabularies**
- **List:** `vocabularies { edges { node { id name description category { key } order aliases } } }`
- **Create:** `vocabularyAdd(input: VocabularyAddInput!)` — input `{ name, category (VocabularyCategory! enum, ~48 values), description?, order?, aliases? }`
- **Update/Delete:** `vocabularyFieldPatch(id: ID!, input: [EditInput!]!)`, `vocabularyDelete(id: ID!)`
- Identity is compound (`category` + `name`) — a name is only unique within its category.

**Status Templates**
- **List:** `statusTemplates { edges { node { id name color } } }`
- **Create:** `statusTemplateAdd(input: StatusTemplateAddInput!)` — input `{ name, color }` (both required)
- **Update/Delete:** `statusTemplateFieldPatch(id: ID!, input: [EditInput!]!)`, `statusTemplateDelete(id: ID!)`
- Manages the reusable name/color library only — assigning a template to a specific entity subtype's ordered workflow (`subTypeEdit(id){ statusAdd/statusFieldPatch/statusDelete }`) is excluded (see Coverage).

**Groups**
- **List:** `groups { edges { node { id name description default_assignation auto_new_marking group_confidence_level { max_confidence } } } }`
- **Create:** `groupAdd(input: GroupAddInput!)` — input `{ name, description?, default_assignation?, auto_new_marking?, group_confidence_level (required: { max_confidence, overrides: [] }) }`
- **Update/Delete:** `groupEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }`

**Roles**
- **List:** `roles { edges { node { id name description } } }`
- **Create:** `roleAdd(input: RoleAddInput!)` — input `{ name, description? }`
- **Update/Delete:** `roleEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }`
- Capability assignment (`roleEdit(id){ relationAdd }`) is excluded (see Coverage).

**Case Templates**
- **List:** `caseTemplates { edges { node { id name description tasks { edges { node { id name } } } } } }`
- **Create:** `caseTemplateAdd(input: CaseTemplateAddInput!)` — input `{ name, description?, tasks: [StixRef!]! }` (`tasks` may be `[]`)
- **Update/Delete:** `caseTemplateFieldPatch(id: ID!, input: [EditInput!]!)`, `caseTemplateDelete(id: ID!)`
- `tasks` are Case Task Template ids — the canvas takes `task_template_names` and resolves them to live ids by listing the Case Task Templates type's own state at deploy time; an unresolved name is skipped with a warning, not a hard failure.

**Case Task Templates**
- **List:** `taskTemplates { edges { node { id name description } } }`
- **Create:** `taskTemplateAdd(input: TaskTemplateAddInput!)` — input `{ name, description? }`
- **Update/Delete:** `taskTemplateFieldPatch(id: ID!, input: [EditInput!]!)`, `taskTemplateDelete(id: ID!)`

**Notifiers**
- **List:** `notifiers { edges { node { id name description notifier_connector_id notifier_configuration } } }`
- **Create:** `notifierAdd(input: NotifierAddInput!)` — input `{ name, description?, notifier_connector_id, notifier_configuration (JSON string) }`
- **Update/Delete:** `notifierFieldPatch(id: ID!, input: [EditInput!]!)`, `notifierDelete(id: ID!)`
- `notifier_connector_id` is the internal id of a built-in (User Interface / Send Mail) or custom notifier connector — these are seeded per-instance, not hardcoded here; find them via `notificationNotifiers`.

**Notification Triggers** (Live knowledge triggers only)
- **List:** `triggers { edges { node { id name description trigger_type event_types filters instance_trigger recipients { id } notifiers { id name } } } }`
- **Create:** `triggerKnowledgeLiveAdd(input: TriggerLiveAddInput!)` — input `{ name, description?, event_types: [TriggerEventType!]! (create/update/delete), notifiers?, instance_trigger, filters?, recipients? }`
- **Update/Delete:** `triggerKnowledgeFieldPatch(id: ID!, input: [EditInput!]!)`, `triggerKnowledgeDelete(id: ID!)`
- `notifiers` are Notifier ids — the canvas takes `notifier_names` and resolves them the same way Case Templates resolve task-template names. Digest and Activity triggers are excluded (see Coverage).

**Retention Rules**
- **List:** `retentionRules { edges { node { id name filters max_retention retention_unit scope active } } }`
- **Create:** `retentionRuleAdd(input: RetentionRuleAddInput!)` — input `{ name, filters?, max_retention (min 1), retention_unit? (minutes/hours/days), scope (knowledge/file/workbench/history/activity), active? }`
- **Update/Delete:** `retentionRuleEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }`

**Stream Collections**
- **List:** `streamCollections { edges { node { id name description filters origin_filters stream_live stream_public } } }`
- **Create:** `streamCollectionAdd(input: StreamCollectionAddInput!)` — input `{ name, description?, filters?, origin_filters?, stream_live?, stream_public? }`
- **Update/Delete:** `streamCollectionEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }` (also has `addGroup`/`deleteGroup`, excluded)

**TAXII Collections**
- **List:** `taxiiCollections { edges { node { id name description filters include_inferences score_to_confidence taxii_public } } }`
- **Create:** `taxiiCollectionAdd(input: TaxiiCollectionAddInput!)` — input `{ name, description?, filters?, taxii_public?, include_inferences?, score_to_confidence? }`
- **Update/Delete:** `taxiiCollectionEdit(id: ID!) { fieldPatch(input: [EditInput]!) / delete }`

**Feeds** (rolling CSV/TAXII export)
- **List:** `feeds { edges { node { id name description filters separator feed_date_attribute rolling_time include_header feed_types feed_public feed_public_user_id feed_attributes { attribute mappings { type attribute relationship_type target_entity_type } multi_match_strategy multi_match_separator } authorized_members { id access_right } } } }`
- **Create:** `feedAdd(input: FeedAddInput!)`
- **Update:** `feedEdit(id: ID!, input: FeedAddInput!)` — **replaces the WHOLE object**, unlike every other type. `feed_public_user_id`/`authorized_members` (not modeled as canvas fields) are read back and carried through unchanged on every update rather than being silently cleared.
- **Delete:** `feedDelete(id: ID!)`

**Entity Settings** (patch-only — no create/delete)
- **Lookup:** `entitySettingByType(targetType: String!)` — OpenCTI seeds one per entity type at install; this type never creates or deletes one.
- **Patch:** `entitySettingsFieldPatch(ids: [ID!]!, input: [EditInput!]!)` — always called with a single-item `ids` array. Fields managed: `platform_hidden_type`, `enforce_reference`, `platform_entity_files_ref`, `attributes_configuration` (JSON), `overview_layout_customization` (JSON array).
- Deploy fails clearly (not "skip", not "create") when a declared `target_type` doesn't resolve to a live setting.

**Ingestion Feeds (TAXII2)**
- **List:** `ingestionTaxiis { edges { node { id name uri collection version authentication_type ingestion_running user_id } } }`
- **Create:** `ingestionTaxiiAdd(input: IngestionTaxiiAddInput!)` — input `{ name, uri, collection, version (TaxiiVersion: v1/v2/v21), authentication_type, authentication_value?, added_after_start?, user_id (required) }`
- **Update/Delete:** `ingestionTaxiiFieldPatch(id: ID!, input: [EditInput!]!)`, `ingestionTaxiiDelete(id: ID!)`

## Coverage (v0.4.0)

Coverage was audited against the OpenCTI GraphQL backend schema source
(`opencti-platform/opencti`, `opencti-platform/opencti-graphql/config/schema/opencti.graphql`
+ `opencti-platform/opencti-graphql/src/modules/**/*.graphql`, cloned 2026-08-04),
not inferred from documentation or convention.

### Managed declarative configuration

All seventeen types in the table above. Every operation, required field, and enum
value listed in "GraphQL operations" was read directly from the schema source —
not guessed. Two types have deliberately unusual shapes, both flagged in-code and
in this README: **Entity Settings** (patch-only, no create/delete — OpenCTI seeds
the singletons) and **Feeds** (`feedEdit` is a whole-object replace, not a field
patch).

### Intentionally excluded

- **Connectors** — `registerConnector` / `managedConnectorAdd` / `managedConnectorEdit`
  require the `CONNECTORAPI` scope carried by a connector's OWN dedicated token
  (self-registration at process start), not an admin/API-token-authored create
  path — there is no `connectorAdd` an operator token can call. The only
  admin-scoped mutations against an EXISTING connector are `deleteConnector(id)`,
  `resetStateConnector(id)`, and `updateConnectorTrigger(id, input:[EditInput]!)`
  (a narrow auto-trigger filter patch) — none of these author a NEW connector.
- **Playbooks** — no atomic "declare the whole graph" mutation exists.
  `playbookAdd` only creates an empty named shell; building the automation graph
  requires N imperative, order-dependent calls (`playbookAddNode`,
  `playbookInsertNode`, `playbookReplaceNode`, `playbookAddLink`,
  `playbookDeleteNode`, `playbookDeleteLink`, `playbookUpdatePositions`) against a
  live, mutable node/link id graph. `playbookFieldPatch` exists, but
  `playbook_definition` is very likely server-derived from the stored graph
  rather than a raw settable attribute — guessing at it risks silently
  corrupting a playbook.
- **RSS / CSV / JSON Ingestion Feeds** — genuinely declarative sibling schemas
  exist (`src/modules/ingestion/ingestion-rss.graphql`, `ingestion-csv.graphql`,
  `ingestion-json.graphql`) alongside the shipped TAXII2 type, each with its own
  `xAdd`/`xFieldPatch`/`xDelete`. Real and a good future-release candidate —
  deferred to keep this pass scoped to the task's specified candidate list.
- **Status Workflows** (per-subtype status assignment) — `subTypeEdit(id){
  statusAdd(input:{template_id,order,scope}) / statusFieldPatch / statusDelete }`
  is real and declarative (attaching an ordered list of Status Templates to a
  specific entity subtype's kanban workflow) but is a materially bigger
  cross-referencing/ordering model than the Status Templates library shipped
  here, and deserves its own dedicated pass.
- **Workflow Definitions** (the newer FSM engine) — `workflowDefinitionSet(entityType,
  definition: String!)` / `workflowDefinitionPublish(entityType)` accept a whole
  JSON state-machine definition per entity type and IS cleanly declarative
  (whole-object replace, like Feeds), but overlaps conceptually with Status
  Workflows above and is a larger subsystem (draft vs. published versions,
  validation errors, async actions) warranting its own carefully-verified pass.
- **STIX knowledge/data objects** (indicators, reports, malware, threat actors,
  relationships, observables, etc.) — this app's scope boundary is platform
  CONFIGURATION, not case data; these are the data the platform manages, not
  its configuration.
- **Runtime/read-only surfaces** — connector live health/queue state, work
  status, background tasks, audit/history logs, the per-recipient notification
  inbox (as opposed to the Notifiers/Triggers that produce it), stream consumer
  telemetry, and playbook execution logs are all read-only or transient, not
  durable desired state.

## Notes

- **Case Templates / Notification Triggers name-resolution**: `tasks`
  (Case Templates) and `notifiers` (Notification Triggers) are cross-references
  by internal id. This app resolves canvas-declared NAMES to live ids at deploy
  and drift time by listing the referenced sibling type's current state — an
  unresolved name is skipped with a warning, not a hard deploy failure. Whether
  `tasks`/`notifiers` accept a plain `EditInput` patch on an EXISTING case
  template/trigger (as opposed to only on create) follows the same generic
  field-patch convention as every other array-valued attribute in this app, but
  is not independently re-verified beyond the schema's type shape.
- **Notification Triggers `recipients`**: a raw list of member/user internal ids
  or emails on the write side; not independently verified beyond `String` in the
  schema.
- **Vocabularies / Kill Chain Phases** have compound identities (`category`+`name`
  and `kill_chain_name`+`phase_name` respectively) — the canvas's single
  `identityField` is informational only; the actual upsert/drift match compares
  both fields.
- **Feeds**: because `feedEdit` replaces the whole object, `feed_public_user_id`
  and `authorized_members` (not exposed as canvas fields) are read back from the
  live feed and carried through unchanged on every update — this type will
  never set or clear them itself.
- **Entity Settings**: `target_type` must already exist on the target OpenCTI
  instance — this type never creates an entity setting, only patches one.
- TLS verification is off by default (self-signed) and configurable via the
  `verify_tls` setting.

Apache-2.0.
