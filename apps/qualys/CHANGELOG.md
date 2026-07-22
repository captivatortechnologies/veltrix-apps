# Changelog

All notable changes to the Qualys app are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Qualys object (asset groups, static search lists, scan schedules), each
  reported difference is now annotated with the person who made the last manual
  change and when, resolved from the Qualys **User Activity Log**. The platform
  stores the `actor` on each diff and the drift view renders it, so a drift alert
  answers *who* and *when*, not just *what*.
  - Attribution queries the classic v2 User Activity Log once per drifted object
    (`POST /api/2.0/fo/activity_log/?action=list&output_format=XML`
    `&since_datetime=<~7d>&truncation_limit=50`) using the same Basic-auth
    service account and `X-Requested-With` header as every other call, and
    correlates entries CLIENT-SIDE to the drifted object by matching its
    name/id inside the entry's `DETAILS`/`ACTION` text (the activity log has no
    structured resource id).
  - It picks the most recent event with an acting login (`USER_NAME`), preferring
    change-type actions (`create`, `update`, `delete`, `add`, `remove`, `edit`,
    …) and falling back to the most recent human event otherwise. `name` comes
    from `USER_NAME`, the timestamp from `DATE`, and the event type from
    `ACTION`.
  - Veltrix's own deploys run through the connection's Qualys service account, so
    a change WE made is excluded via the connection login — the attribution
    reflects the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a non-OK response (for example when the service
    account's role lacks Activity Log / API access), an empty log, or no usable
    event, the diff is reported without an actor and the drift view shows "—". It
    never fabricates. Only objects that actually drifted are attributed (one
    activity-log query per drifted object).
