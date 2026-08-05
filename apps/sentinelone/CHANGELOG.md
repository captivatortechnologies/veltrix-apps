# Changelog

All notable changes to the SentinelOne app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-08-05

### Added
- **Four new configuration types, deepening config-as-code coverage from 6 to
  10 types** (config-type count doubling justified a MINOR bump):
  - **`s1-firewall-rules`** — Firewall Control network rules via
    `/firewall-control` (Control SKU). Reconciled by rule name at the
    configured scope; the same list/create/update/delete request shape this
    app already uses for `/exclusions`.
  - **`s1-device-control`** — USB / Bluetooth peripheral rules via
    `/device-control`. Reconciled by rule name; validate warns when a
    USB-only field (vendor/product/serial id) is set on a Bluetooth rule or
    vice versa.
  - **`s1-notification-recipients`** — alert email/SMS recipients via
    `/settings/recipients`. Reconciled by email; restricted to the
    account/site/global scopes (there is no group-scoped recipients
    endpoint).
  - **`s1-rbac-roles`** — custom RBAC roles via `/rbac/roles`. Permissions are
    declared as dot-path key → value overrides and merged with a
    read-merge-write against the scope's new-role template (`GET
    /rbac/role`) or an existing role's live detail (`GET /rbac/role/{id}`) —
    the same pattern the existing `s1-agent-policy` config type already uses,
    since SentinelOne's permission taxonomy is tenant/SKU-specific and not
    hardcoded here.
  - All four ship with validate/deploy/rollback/healthCheck/driftDetect/
    getStatus handlers, drift attribution (reusing `lib/s1ActivityLog.ts`),
    and unit tests, and are wired into `manifest.yaml` with `group:` sidebar
    labels (Firewall Control / Device Control / Notifications / Access
    Control) alongside newly-added labels for the 6 existing types
    (Exclusions & Restrictions / Detection Rules / Agent Policy /
    Organization).

### Notes
- No changes to the shared `lib/s1.ts` client or `lib/s1ActivityLog.ts` — all
  four new types reuse the existing scope/pagination/error-handling client and
  drift-attribution helpers as-is.
- Researched and deliberately excluded this pass (see the README's new
  **Coverage** section for full reasoning): Sites (`/sites` — commercial
  license-pool semantics could not be verified from an authoritative source),
  SMTP/SSO/Active Directory settings (secret material), Syslog forwarding
  settings and Scheduled reports (endpoints exist but no verifiable
  write-body schema was found), Ranger/attack-surface-management, Marketplace
  app installs, and User accounts.

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
