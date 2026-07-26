# Changelog

All notable changes to the Cortex XSOAR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
