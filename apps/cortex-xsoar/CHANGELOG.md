# Changelog

All notable changes to the Cortex XSOAR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-04

### Added
- **Incident fields configuration type (`xsoar-incident-fields`)** and
  **indicator fields configuration type (`xsoar-indicator-fields`)**. Manage
  custom Cortex XSOAR incident/indicator fields as code through the server
  REST API. Incident and indicator fields are the same underlying server
  object, sharing one listing endpoint (`GET /incidentfields`) and one import
  endpoint (`POST /incidentfields/import`), discriminated by the `group`
  number (0 = incident, 2 = indicator — XSOAR's own `GroupFieldTypes` enum)
  and the `id` prefix. Each field reconciles by its **cliName** (lowercase
  alphanumeric); the server `id` is always derived as `incident_<cliName>` /
  `indicator_<cliName>` rather than authored directly, and a cliName that
  collides with one of XSOAR's reserved internal columns (`name`, `type`,
  `score`, …) is rejected at validate time. Field type is checked against the
  exact enum each kind supports (indicator fields drop `attachments`,
  `internal` and `timer`, which are incident-only). Built-in/locked fields
  are never modified. Delete-on-rollback follows the same
  `POST /<resource>/delete` action convention already shipped for lists and
  incident types — flagged in the README as inferred rather than
  independently confirmed, since no source documents an incident-field
  delete contract.
- **Classifiers configuration type (`xsoar-classifiers`)** and **mappers
  configuration type (`xsoar-mappers`)**. Manage Cortex XSOAR classifiers and
  incoming/outgoing mappers as code. Both are the same underlying server
  object, sharing one listing endpoint (`POST /classifier/search`) and one
  import endpoint (`POST /classifier/import`), discriminated by `type`
  (`classification` vs. `mapping-incoming` / `mapping-outgoing`). Each
  reconciles by a caller-chosen **id** (also the required `classifierId` sent
  on every save). The classification-rule graph (`keyTypeMap` + `transformer`)
  and the field-mapping graph (`mapping`) are deep, variable schemas — as with
  Cisco Meraki's group-policies precedent, they are authored as one JSON blob
  merged onto the typed fields rather than exhaustively modeled, and are not
  diffed field-by-field by drift detection (only the typed fields and the
  object's presence are reconciled). Built-in/locked classifiers/mappers are
  never modified. Delete-on-rollback follows the same inferred
  `POST /classifier/delete` convention, flagged the same way.
- **Multipart upload support in the shared `XsoarClient`**
  (`lib/xsoar.ts` `requestMultipart`). The four new configuration types all
  save through XSOAR's "import" endpoints, which are genuine file uploads
  (`multipart/form-data`) even though the file content is JSON — confirmed
  against the official generated `demisto-py` client and `demisto-sdk`'s
  content-graph upload path. Reuses the same auth-header building and 429
  retry policy as the existing JSON request path.
- Two shared plumbing modules for the new types, mirroring the existing
  `config-types/lib/xsoarAudit.ts` convention: `config-types/lib/xsoarFields.ts`
  (incident/indicator field id derivation, type/reserved-name tables, list/
  save/delete) and `config-types/lib/xsoarClassification.ts` (classifier/mapper
  kind detection, search/save/delete, JSON-blob parsing).
- README **Coverage** section auditing the full Cortex XSOAR content-as-code
  surface — every configuration type this app manages, plus what was
  evaluated and intentionally excluded (pre-process rules, roles, playbooks,
  integration secrets) with the specific reason for each.

## 1.2.0 — 2026-07-26

### Added
- **Integration instances configuration type (`xsoar-integration-instances`).**
  Manage Cortex XSOAR integration instances — and their parameters — as code
  through the server REST API. Each instance is reconciled by its **name**:
  - **Deploy** searches every instance (`POST /settings/integration/search`,
    which returns `{ instances, configurations }`) and upserts via
    `PUT /settings/integration`. A new instance is built from the integration's
    module **configuration** (its parameter definitions), so declared parameter
    values land on the correct fields and required defaults are preserved; an
    existing instance is updated in place with the content-override version. The
    `enabled` flag is written in XSOAR's string form (`"true"`/`"false"`), and
    the instance can be wired to an existing classifier / incoming / outgoing
    mapper (`mappingId`, `incomingMapperId`, `outgoingMapperId`).
  - **Rollback** deletes instances this deploy created
    (`DELETE /settings/integration/{id}`) and restores updated instances to their
    captured prior body.
  - **Drift** reports a missing instance as critical, and a changed enabled flag,
    classifier/mapper id, or **non-secret** parameter value as informational,
    with the same best-effort "who changed it + when" attribution as the other
    types. Encrypted/secret parameters (XSOAR types 4 and 9) are masked by the
    API, so they are set on create but never compared.
  - **Health** verifies API reachability and that every declared instance is
    present.
- Shared `readKeyValueMap` canvas-field reader (in `lib/fields.ts`) for
  name/value parameter maps, tolerating object, pair-array and `k=v` string
  forms.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Cortex XSOAR object (a **list**, **incident type** or scheduled
  **job**), each reported difference is now annotated with the person who made
  the last manual change and when. The platform stores the `actor` on each diff
  and the drift view renders it, so a drift alert answers *who* and *when*, not
  just *what*.
  - Attribution resolves once per drifted object from two best-effort sources, in
    order: (1) the drifted object's own **modifier field** (`modifiedBy`
    alongside a `modified` timestamp) when the live object records a non-Veltrix,
    non-system writer — no extra request; then (2) the server **audit trail**
    (`POST /settings/audits` with `{ page, size, fromDate: <~7d> }`), whose
    entries are correlated CLIENT-SIDE to the drifted object by its **name** (the
    XSOAR identity) or id.
  - It picks the most recent **human** actor (a named user that is not XSOAR's
    "DBot" automation user), preferring change-type actions (`create`, `update`,
    `delete`, `save`, `enable`, `disable`, …) and falling back to the most recent
    human event otherwise. `id`/`name` come from the entry's `user`/`userName`,
    the timestamp from `created` (then `modified`), and the event type from
    `action`.
  - Veltrix's own deploys run through the connection's API key, so a change WE
    made is excluded via the connection login — the attribution reflects the
    *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a non-OK response (for example when the API key lacks
    permission to read the audit trail), an empty log, or no usable human event,
    the diff is reported without an actor and the drift view shows "—". It never
    fabricates. Only objects that actually drifted are attributed.
