# Changelog

All notable changes to the Cortex XSOAR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
