# Changelog

All notable changes to the Zscaler app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-07-22

### Added
- **Drift attribution ("who changed it + when").** When drift is detected on a
  ZIA or ZPA object, each diff now carries a best-effort `actor` — the person who
  last changed the resource and the timestamp — read directly from the modifier
  fields the drift check already fetches (ZIA `lastModifiedBy` / `lastModifiedTime`,
  ZPA `modifiedBy` / `modifiedTime`), so no extra API call or audit-report flow is
  needed. Changes made by Veltrix's own deploy identity are excluded so only
  manual changes are attributed. Attribution is strictly best-effort: a resource
  with no modifier field (or one changed by us) is reported without an actor, and
  attribution can never fail a drift check. Wired into all 31 rule/object drift
  handlers (the presence-only Locations type has no attributable field drift).

## 1.2.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 7 collapsible sections split by
  service — ZIA (Policy Rules, Objects & Groups, DLP, Traffic Forwarding,
  Administration) and ZPA (Infrastructure, Applications & Policy) — so all 32
  configuration types stay navigable. Sections collapse by default, remember
  whether you left them open, and always expand the one you're currently
  working in.
