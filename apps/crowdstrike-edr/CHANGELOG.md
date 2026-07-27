# Changelog

All notable changes to the CrowdStrike Falcon app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.9.0 — 2026-07-27

### Added
- **File Integrity Monitoring (FileVantage)** — a new sidebar group with three
  configuration types on the self-contained `/filevantage/` collection:
  - **FileVantage Policy** — per-platform FIM policy (enable/disable, host-group
    and rule-group assignment).
  - **FileVantage Rule Group** — reusable rule groups with their monitoring rules
    (path, depth, watched attributes, include/exclude), rules embedded in the group.
  - **FileVantage Scheduled Exclusion** — time-windowed suppression (recurrence,
    timezone, processes/users/paths) bound to a policy.
- Shared `lib/filevantageAdapter.ts` (query→get→CRUD-by-name transport for the
  FileVantage collection), unit-tested.

## 1.8.0 — 2026-07-27

### Added
- **Eight new configuration types**, grouped in the sidebar by Falcon API family
  (like the Okta app), all reusing the shared `lib/falcon.ts` client:
  - **Endpoint Policies** — Sensor Update Policy (build pinning n/n-1/n-2,
    uninstall protection, update scheduling), Response (Real Time Response)
    Policy (RTR capability tiers), USB Device Control Policy (v2 — per
    device-class enforcement with vendor/product exceptions), Content Update
    Policy (rapid-response content ring assignments), and Custom IOA Rule Groups
    (per-platform indicator-of-attack rules).
  - **Exclusions** — ML, IOA, and Sensor Visibility exclusions, applied globally
    or to host groups.
- **Shared policy/exclusion adapters** (`lib/policyAdapter.ts`,
  `lib/exclusionAdapter.ts`) that factor the proven Falcon lifecycle mechanics —
  the `name:~` contains-then-exact paged lookup, create-disabled → enable, the
  `*-actions` host-group attach/detach, and exclusion query→get→CRUD transport —
  so the endpoint-policy types share one code path. Unit-tested.
- Existing types (Host Groups, Prevention Policies, Custom IOCs) are now assigned
  to sidebar groups (Host & Assets, Endpoint Policies, Indicators).

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
