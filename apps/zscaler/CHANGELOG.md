# Changelog

All notable changes to the Zscaler app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-08-05

### Added
- **ZIA Forwarding Control Rules** (`zia-forwarding-control-rules`, `/forwardingRules`).
  The last standard ZIA policy-rule surface this app didn't yet manage: rules
  that decide how matching traffic leaves the Zscaler cloud — forwarded
  directly, proxy-chained to a next-hop gateway, routed to a ZPA App Connector
  (`forwardMethod: ZPA`/`ECZPA`), or dropped. Same shape as the other 8 ZIA
  Policy Rules types (name/order/state + a `rule_json` criteria escape hatch),
  staged and activated as a batch. ZIA ships several predefined forwarding
  rules (e.g. "ZPA Pool For Stray Traffic") that this refuses to modify or
  delete, matched by name since the API returns no `predefined` flag on this
  resource. 33 configuration types total.

### Changed
- Added a README **Coverage** section listing every managed configuration type
  by group alongside the platform surface intentionally left out (one-shot
  activation, read-only references, write-only secrets, non-round-trippable
  actions), each with a sourced reason.

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
