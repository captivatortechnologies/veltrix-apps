# Changelog

All notable changes to the Splunk Cloud app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.10.1 — 2026-07-22

### Fixed
- Access Servers: the Add/Edit dialog now refetches connections, ZTNA providers,
  and environments each time it opens, so a connection created on the Connections
  page appears in the "Connection" dropdown immediately instead of requiring a
  page refresh (the list was previously loaded only once on page mount).

## 1.10.0 — 2026-07-21

### Added
- **Live ACS-backed pickers for object-reference fields.** Config fields that
  name another live Splunk Cloud object are now searchable pickers instead of
  free-text, backed by the stack's Admin Config Service (ACS) with the JWT the
  app already uses:
  - HEC Tokens **Default Index** (`remote-select`) and **Allowed Indexes**
    (`remote-multiselect`) — search the stack's live indexes (ACS `/indexes`).
  - App Permissions **App** (`remote-select`) — search the stack's installed
    apps, built-in premium apps included (ACS `/permissions/apps`).

  Stored value shapes are unchanged (single index / list of index names / single
  app id), so the existing validate/deploy/drift handlers keep working. Each
  picker falls back to a clear "save the connection first" / "store the ACS JWT"
  message when the connection isn't ready. Role- and user-reference fields
  (which need the Support-gated management REST port) and wildcard-capable fields
  intentionally remain free-text.

## 1.9.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 5 collapsible sections — Data,
  Network & Access, System Settings, Apps, and Access Control — so all 13
  configuration types stay navigable. Sections collapse by default, remember
  whether you left them open, and always expand the one you're currently
  working in.
