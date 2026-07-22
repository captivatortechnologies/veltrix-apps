# Changelog

All notable changes to the Splunk Enterprise app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.19.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  Splunk **App** or **HEC Token**, the app now resolves WHO last manually changed
  the object and WHEN, and attaches it to each drift diff (rendered by the
  platform; `—` when unknown). Attribution reads Splunk's internal `_audit`
  index via a single BLOCKING search export — `POST
  /services/search/v2/jobs/export` (falling back to
  `/services/search/jobs/export` on older splunkd) — running `search
  index=_audit action=* object="<name>" | head 20 | table _time user action
  object` over the last 7 days, keyed on the drifted object's NAME (Splunk audit
  keys on object name, not an id). Each result row maps to `user` (actor),
  `_time` (when), and `action` (event type).
- The resolver prefers a change-type action (`edit`/`create`/`delete`/…) and
  otherwise falls back to the most recent human event. Veltrix's own deploys are
  excluded by the connection's service-account username, and Splunk internal
  principals (e.g. `splunk-system-user`) are never attributed. Attribution is
  STRICTLY best-effort with a short timeout: any error, empty result, or
  no usable human event leaves the diff unattributed and never fails a drift
  check. Only objects that actually drifted are queried, once each.

## 1.18.0 — 2026-07-21

### Added
- **Live index pickers for HEC tokens.** The HEC Token config type's **Default
  Index** and **Allowed Indexes** fields are now searchable pickers backed by the
  connected instance's live indexes (via `GET /services/data/indexes`,
  `datatype=all`) instead of free-text. Default Index is a single-select
  (`remote-select`); Allowed Indexes is a multi-select (`remote-multiselect`).
  The stored value shape is unchanged — Default Index still stores one index
  name, Allowed Indexes still stores a list of names — so the existing
  validate/deploy/drift handlers keep working. Falls back to a clear "save the
  connection first" message when no deploy target is registered yet.
