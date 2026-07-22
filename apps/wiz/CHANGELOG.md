# Changelog

All notable changes to the Wiz app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Wiz object (service accounts, custom cloud configuration rules), each
  reported difference is now annotated with the person who made the last manual
  change and when, resolved from the Wiz **audit log** (`auditLogEntries`). The
  platform stores the `actor` on each diff and the drift view renders it, so a
  drift alert answers *who* and *when*, not just *what*.
  - Attribution queries the audit log per drifted object over a ~7-day window
    (`filterBy: { timestamp: { after: … } }`) and correlates entries to the
    drifted object by matching its id (preferred) or name against the entry's
    `actionParameters` — Wiz's audit log has no per-object subject field, so
    correlation is done client-side.
  - It picks the most recent **human** entry (one bearing a `user`, not a
    service account), preferring change-type actions (`Create*`, `Update*`,
    `Delete*`, `Rotate*`, …) and falling back to the most recent human entry
    otherwise. The actor carries the user's id, name and email plus the action
    and timestamp.
  - Veltrix's own deploys authenticate as a Wiz **service account** (recorded
    with no `user`) and are therefore never treated as a human actor; the
    connection's Client ID is additionally excluded so the attribution reflects
    the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a timeout, an empty or unavailable audit log, or no
    usable human entry, the diff is reported without an actor and the drift view
    shows "—". Only objects that actually drifted are queried (one audit query
    per drifted object).
