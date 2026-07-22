# Changelog

All notable changes to the Splunk Enterprise app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

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
