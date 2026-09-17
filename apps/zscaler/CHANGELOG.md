# Changelog

All notable changes to the Zscaler app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.4.4 — 2026-09-17

### Fixed — drift stops claiming "in sync" from a run that could not look

`driftDetect` returned a bare `{ hasDrift: false, diffs: [] }` when the client
could not be built — no usable credential, no tenant host. That is not "I checked
and it matches": the platform treats `hasDrift: false` as a positive assurance
and resolves the component's outstanding drift record with `drift_cleared`, so a
rotated or revoked credential silently wiped real drift on the next scheduled
run.

Those paths now return `checked: false`, on which the platform records nothing
and clears nothing. An earlier catalog-wide pass fixed the single-line spelling
of this guard; this is the braced form it did not match, and `veltrix validate`
now rejects both.

## 1.4.3 — 2026-09-16

### Fixed — drift now compares the three fields that decide what a rule DOES

Three drift handlers compared presence, order and state, and stopped there — so
the setting each config type exists to manage could be changed in the console and
every scheduled run still reported the estate in sync:

- **`zia-sandbox-rules`** did not compare `ba_rule_action`. A rule flipped from
  BLOCK to ALLOW stops quarantining malware.
- **`zia-ssl-inspection-rules`** did not compare the action type. A rule switched
  from DECRYPT to DO_NOT_DECRYPT silently stops inspecting TLS for everything it
  matches.
- **`zia-admin-users`** did not compare the role, though deploy writes it and
  rollback restores it. A managed analyst account escalated to Super Admin read
  as healthy.

Each is now compared, at `critical` severity, and only where the canvas actually
declares the value — a rule left on the tenant default is not managed here and
cannot drift. A value the tenant no longer reports reads as `not set` rather than
being skipped, because "I could not read it" is not "it matches".

The surrounding rule_json body is still deliberately not deep-diffed: ZIA
normalises references and echoes defaults, so comparing it produces phantom
drift. These are single un-normalised scalars, which is what makes them the
exception.

## 1.4.2 — 2026-09-16

### Fixed — a created object with no rollback record, and a health check that crashed

**`deploy` now records what it created before anything else can throw.** The
POST was checked for `res.ok` first, so by the time the id check ran the object
existed in the tenant — and that check threw BEFORE the rollback entry was
pushed. The deploy reported "failed, nothing to undo" about a live firewall,
DLP or access rule it had just created. Worse, the next deploy's name match
found that object and took the update path, recording the half-made object as
the "prior state", which put the real pre-deploy state permanently out of reach.
Every rollback entry type already had an optional id, so an entry without one is
recorded immediately and the id filled in once it is known. 33 configuration
types.

**`healthCheck` reports an unreadable listing instead of throwing it.** Only the
reachability probe was wrapped; the presence listing after it sat in no
try/catch and every `listX` throws on a non-OK response. So the most likely real
failure — a OneAPI client granted the tenant status role but not the resource
role — surfaced as an opaque pipeline crash rather than `healthy: false` with a
message naming the missing scope, and the reachability check that HAD passed was
lost with it. 32 configuration types; `zpa-policy-rules` already did this
correctly and was the template.

## 1.4.1 — 2026-09-16

### Fixed — drift no longer claims "in sync" from a run that could not look

`driftDetect` returned `{ hasDrift: false, diffs: [] }` when it had no usable
credential, and again when the vendor refused the read. That is not "I checked
and found nothing" — it is "I never looked". The platform cannot tell the
difference: it treats `hasDrift: false` as a positive assurance and resolves the
component's outstanding drift record with `drift_cleared`.

So a rotated credential, a de-scoped API user or a vendor maintenance window
silently wiped real drift on the next scheduled run, and the console showed a
clean estate.

Those paths now return `checked: false` (`DriftResult.checked`, SDK 3.9.0), on
which the platform records nothing and clears nothing. Where a handler loops
over several objects and skips the ones it could not read, the run reports
`checked: false` too, rather than "in sync" from a partial view. A return that
genuinely established "nothing is deployed, so there is no drift" is unchanged.

`veltrix validate` now rejects the bare form, so it cannot come back.

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
