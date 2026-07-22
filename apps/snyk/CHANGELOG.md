# Changelog

All notable changes to the Snyk app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Snyk object (SAST settings, notification settings, SCM/registry
  integration settings, service accounts and webhooks), each reported difference
  is now annotated with the person who made the last manual change and when,
  resolved from the Snyk **Audit Logs** REST API
  (`GET /rest/orgs/{org_id}/audit_logs/search`). The platform stores the `actor`
  on each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - Attribution queries the org audit log once per drifted object over a ~7-day
    window (`sort_order=DESC`), then correlates each event to the target
    **client-side**: per-object types (integrations, service accounts, webhooks)
    match the object's Snyk id or name/URL inside the event `content`;
    org-singleton types (SAST, notifications) match by event-name prefix
    (`org.sast_settings` / `org.settings`, `org.notification_settings` / …) — so
    an unrelated object's change is never mis-attributed.
  - It picks the most recent event with a **resolvable acting user**
    (`userId` / `user_id` / `user_public_id`), preferring change-type events
    (`.edit`, `.create`, `.add`, `.delete`, `.remove`, …) and falling back to the
    most recent usable event otherwise. `at` = the event `created`,
    `eventType` = the event name.
  - Veltrix's own deploys authenticate with the connection's service-account
    token, so their audit events are excluded via the connection identity
    (`veltrixActorLogins`), leaving the attribution on the *manual* change rather
    than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an unreachable/forbidden audit scope, an empty log, or
    no usable event, the diff is reported without an actor. Only objects that
    actually drifted are queried (one audit query per drifted object).
