# Changelog

All notable changes to the CrowdStrike Falcon app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.7.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Falcon object (host groups, prevention policies, custom IOCs), each
  reported difference is now annotated with the person who made the last change
  and when. The platform stores the `actor` on each diff and the drift view
  renders it, so a drift alert answers *who* and *when*, not just *what*.
  - Attribution reads the modifier Falcon records DIRECTLY on the drifted
    resource — `modified_by` + `modified_timestamp` on prevention policies and
    host groups, `modified_by` + `modified_on` on custom IOCs — which the drift
    check already fetches. This is the most reliable actor source (the
    resource's own record of its last writer) and needs no extra API call or
    scope, so no separate audit-log query is made.
  - An email-shaped modifier (policies, host groups) is surfaced as the actor's
    email; an opaque user/API-client id (IOCs) is surfaced as the actor id. The
    raw value is always kept as the display name.
  - Veltrix's own deploys are recorded under the connection's Falcon API client
    id, so a change WE made is excluded via that client id — the attribution
    reflects the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, or when the resource carries no usable modifier (for
    example a deleted object that no longer exists to read), the diff is reported
    without an actor and the drift view shows "—". Only objects that actually
    drifted are attributed (one resolution per drifted object).
