# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.6.0 — 2026-08-05

### Added
Research-first exhaustiveness pass against the QRadar REST API (versions 20.0
and 27.0 endpoint docs). Of the candidate surfaces reviewed — custom
rules/building blocks, log source groups, saved searches (AQL), offense rules,
retention buckets, user roles/security profiles, forwarding
destinations/routing rules — only **log source groups** plus four genuinely
untapped **Ariel/AQL** surfaces and one **disaster-recovery** surface had a
real, round-trippable write API. Everything else is documented as excluded in
the README Coverage section, with the specific endpoint behavior cited.

- **Log Source Groups** — named folders in the log-source-management group
  hierarchy (`/config/event_sources/log_source_management/log_source_groups`).
  The parent group is declared by name and resolved to `parent_id` at deploy
  time (a worklist creates parents before children regardless of declaration
  order). The API supports create + read only — no update, no delete — so this
  type is append-only, matching the existing offense-closing-reasons pattern.
- **Ariel Lookups** (`/ariel/lookups`) — named key=value maps (plus a default
  value) used by AQL expressions to translate raw field values into readable
  labels. Name-keyed, full create/update/delete; the field type is immutable
  after creation, matching the reference-data element-type convention already
  used by Reference Sets/Maps.
- **Tagged Field Categories** (`/ariel/taggedfieldcategories`) — named UI
  groupings for Ariel tagged fields. Full create/update/delete, rename-safe by
  id (same shape as Domains/Custom Log Source Types).
- **Tagged Fields** (`/ariel/taggedfields`) — named IPFIX/NetFlow information
  elements (private enterprise number + element id) usable in AQL, classified
  into a category declared by name. Name, type, private enterprise number,
  element id and is-array are immutable once created (the update API only
  allows category + description); a drifted immutable field fails deploy with
  guidance to delete and recreate instead of attempting an unsupported change.
- **Flow VLANs** (`/ariel/flow_vlans`) — enterprise/customer VLAN id pairs used
  to disambiguate overlapping VLAN spaces in flow data (e.g. across MSSP
  tenants). The API has no name field and no update endpoint, so the
  (enterprise, customer) pair itself is the identity; a canvas-only "Label"
  field is never sent to QRadar. Changing either id is a natural delete of the
  old pair plus create of the new one via reconcile.
- **Disaster Recovery Ariel Copy Profiles**
  (`/disaster_recovery/ariel_copy_profiles`) — continuous event/flow
  replication from a managed host to a DR destination. QRadar allows one
  profile per host, so `host_id` (declared directly, matching the Bandwidth
  Manager convention) is the real identity rather than the canvas item. Excluded
  event/flow retention buckets are declared by name and resolved to ids via two
  new read-only lookups. Full create/update/delete.
- `lib/lookups.ts`: added `listLogSourceGroups`, `listTaggedFieldCategories`,
  `listEventRetentionBuckets` and `listFlowRetentionBuckets` (all read-only
  GETs, following the existing name→id lookup convention).
- Added a `group:` to every configuration type (existing and new) so the
  Configuration Canvas selector organizes the app's 24 types into named
  sections (Reference Data / Log Sources / Event & Flow Properties / Network &
  Topology / Access & Tenancy / Offenses / System / Ariel / AQL / Disaster
  Recovery) instead of one flat list.
- README: added a **Coverage** section listing every managed configuration
  type by group and every intentionally excluded QRadar surface with its
  specific endpoint citation and reason.

## 0.5.0 — 2026-07-26

### Added
- **Log Sources** — manage QRadar log sources (named event feeds). The log
  source type and protocol are declared by name and resolved to their numeric
  ids at deploy time, and each protocol parameter's id is filled from the chosen
  protocol type. Matched by name (rename-safe by id); created/updated and
  reconcile-deleted.
- **Custom Log Source Types** — manage custom DSMs (name + optional default
  protocol by name). Only custom types are managed; built-in types are protected
  and never modified or deleted.
- **Custom Event Properties** and **Flow Custom Properties** — a regex property
  (unique name) plus per-log-source-type extraction expressions, reconciled as a
  nested child set; the event and flow variants share one engine.
- **Calculated Event Properties** — a value computed from two operands
  (STATIC/PROPERTY) and an arithmetic operator.
- **Remote Networks** and **Remote Services** — named CIDR ranges (with an
  optional group). Staged writes are applied with a single INCREMENTAL deploy
  (single-flight tolerant).
- **Network Hierarchy** — grouped named CIDR objects applied as a whole-list
  staged replace that preserves the operator's existing objects and only
  replaces/removes objects this app owns, then an INCREMENTAL deploy.
- **Tenants** — named multi-tenancy boundaries with optional event/flow rate
  limits.
- **Resource Restrictions** — data-window / execution-time / record-limit caps
  for a tenant or role (target by name → id; updated via PUT). User targets are
  excluded.
- **Offense Closing Reasons** — short analyst-selectable close texts. Append-only
  (the API has no update or delete), so reasons are created if missing but never
  removed or renamed.
- **Bandwidth Manager** — store-and-forward traffic-shaping configurations (KB
  limit per managed host, or all hosts with host id -1). Matched by name
  (rename-safe by id); created/updated and reconcile-deleted. Filters are out of
  scope (they reference a configuration id and carry port-mask/partner semantics).
- **QID Records** — normalized event definitions (log source type + name + low
  level category + severity) with nested DSM event mappings; the log source type
  and category are declared by name and resolved to their ids. Append/update-only:
  the API has no delete for QID records or event mappings, so they are created and
  updated but never removed. Deploy matches app-created records by their stored id
  and uses targeted `filter=` queries (not full listings) to stay efficient
  against the large built-in QID set. Added a read-only low-level-category lookup
  to `lib/lookups.ts`.
- `lib/qradar.ts`: added `PUT` to the method union and a shared
  `deployStagedConfig` helper (POST `/staged_config/deploy_status`, INCREMENTAL,
  async + single-flight 409/1002 tolerant). New `lib/lookups.ts` (read-only
  name→id lookups for log source types, protocol types, tenants and user roles)
  and `lib/customProperties.ts` (shared regex-property + expressions engine).

## 0.4.0 — 2026-07-26

### Added
- **Reference Tables** configuration type — manage QRadar reference tables
  (named collections of `outer key -> column -> value` cells with typed columns)
  as code, with the full pipeline handler set. Tables are matched by name; their
  cells are reconciled to exactly the declared set (add/update, remove extra);
  typed columns (`key_name_types`) are applied at creation; the value element
  type is immutable; reconcile only deletes tables this app created.
- **Domains** configuration type — manage QRadar domains (named segmentation
  boundaries with a description) as code, with the full pipeline handler set.
  Domains are matched by the stored QRadar id first (rename-safe) and fall back
  to name; missing domains are created, descriptions updated when they drift, and
  reconcile only deletes domains this app created.

## 0.3.0 — 2026-07-26

### Added
- **Map of Sets** configuration type — manage QRadar map-of-sets (named
  collections where each key holds a *set* of values) as code, with the full
  pipeline handler set. Collections are matched by name; their `(key, value)`
  pairs are reconciled to exactly the declared set (add missing pairs, remove
  extra); the value element type is immutable; reconcile only deletes
  collections this app created.

## 0.2.0 — 2026-07-26

### Added
- **Reference Maps** configuration type — manage QRadar reference maps (named,
  typed `key=value` collections) as code, with the full pipeline handler set.
  Maps are matched by name; their entries are reconciled to exactly the declared
  set (add/update, remove extra); the element type is immutable; reconcile only
  deletes maps this app created.

## 0.1.0 — 2026-07-26

### Added
- Initial release. IBM QRadar REST API client (`lib/qradar.ts`) with `SEC`
  authorized-service-token auth, the required `Version` header, and the classic
  reference-data set operations (create / get / add value / delete value /
  delete set).
- **Reference Sets** configuration type — manage QRadar reference sets (named,
  typed value collections) as code, with the full pipeline handler set: validate,
  deploy, rollback, drift detection, health check and status. Sets are matched by
  name; their values are reconciled to exactly the declared list (add missing,
  remove extra); the element type is immutable, so a same-name set of a different
  type is not modified; reconcile only deletes sets this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the SEC-token credential and the `ibm-qradar` deploy target.
- Connection test (`handlers/testConnection.ts`) listing the reference-data sets.
