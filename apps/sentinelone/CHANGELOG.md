# Changelog

All notable changes to the SentinelOne app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed SentinelOne object (exclusions, blocklist hashes, hash allowlist, STAR
  rules, the per-scope agent policy, and groups), each reported difference is now
  annotated with the person who made the last manual change and when, resolved
  from the **SentinelOne Activities API**
  (`GET /web/api/v2.1/activities`). The platform stores the `actor` on each diff
  and the drift view renders it, so a drift alert answers *who* and *when*, not
  just *what*.
  - Attribution pulls a recent page of activities (createdAt DESCENDING, last
    ~7 days) and correlates each activity to the drifted object **client-side**:
    an activity matches when the object's id or name/value appears in the
    activity's scope ids (`groupId`/`siteId`/`accountId`), its `data` payload, or
    its descriptions. Uncorrelated activities are dropped, so an unrelated
    object's change is never mis-attributed. One activities query runs per
    drifted object.
  - It picks the most recent **human** actor (an activity carrying an acting
    `userId` or a user display name in `data`; system/agent activities with no
    user are excluded), preferring change-type descriptions (created / updated /
    deleted / …) and falling back to the most recent human activity otherwise.
    The actor's name is the display name from the activity payload, or the user
    id when no name is present; the timestamp is the activity's `createdAt`.
  - Veltrix's own deploys authenticate with the connection's SentinelOne service
    user (API token), so those activities carry that user as the actor. The
    connection's username is excluded from attribution, so a reported actor
    reflects the manual change, not our own deploy.
  - **Strictly best-effort:** attribution can never throw or fail a drift check.
    On any API error, an empty log, or no usable human activity, the diff is
    reported without an actor. If the connection's API token cannot read the
    Activities API, or activities cannot be correlated to the managed object, the
    actor is simply left unset.

### Notes
- No new permissions are required — attribution reuses the existing
  `credential:read` grant and the SentinelOne console component. The new
  `lib/s1ActivityLog.ts` module is unit-tested (`pickActorFromEvents` and the
  best-effort resolve/attach/exclusion helpers).
