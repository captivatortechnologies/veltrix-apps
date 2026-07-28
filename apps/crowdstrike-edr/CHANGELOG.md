# Changelog

All notable changes to the CrowdStrike Falcon app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.13.1 — 2026-07-28

### Fixed (remaining low-severity review findings)
- **Cloud compliance controls** — rollback of a just-created control now deletes it
  by the id captured at create (with a name-lookup fallback), instead of re-querying
  first, so an eventually-consistent query can no longer leak the control.
- **Users** — role grant/revoke deltas are recorded *before* each batch action, so a
  partial batch apply that still errors is fully reversible on rollback.
- **NG-SIEM data connections** — the source endpoint is captured and restored on
  rollback (alongside the repository), so a wholesale `config` replace no longer
  strips it. (The credential is still never captured or restored.)
- Remaining documented limitation: IDP policy-rule drift/deploy scope to declared
  condition keys, so a removed condition isn't reconciled (needs nested-tree diff).

## 1.13.0 — 2026-07-28

### Added
- **MSSP / Flight Control** — a new sidebar group completing Platform Administration:
  - **CID Group** — Flight Control CID groups + member child CIDs.
  - **User Group** — Flight Control user groups + member user UUIDs.
  - **Role Mapping** — binds a user group ↔ CID group ↔ roles (grants are additive,
    so drift-correction diffs and revokes extras).
- Requires parent-CID credentials with Flight Control scope (MSSP tenants only) —
  noted in each type's description.

### Fixed (from an adversarial logic review)
- **Recon monitoring rules** — a blank `actions` field no longer converges to
  zero (it now leaves pre-existing notification actions untouched, matching drift),
  and actions this deploy deletes are captured and **recreated on rollback**, so
  rollback is again the exact inverse of deploy. (Previously a rule edited through
  Veltrix could silently, irreversibly destroy console-created notifications.)
- **Custom IOA rule groups** — drift now compares disposition, pattern severity,
  field values, and description of each rule (not just presence + enablement), so a
  manual weakening of a deployed rule is reported instead of silently missed.

## 1.12.1 — 2026-07-28

### Added / Fixed
- **`FalconClient.requestMultipart`** — a multipart/form-data capability on the
  shared client (same auth + 401/429 retry as `request()`), for endpoints that
  only accept file uploads.
- **RTR Custom Scripts and Put-Files now deploy correctly** — their create/update
  are multipart-only; they were previously sending a JSON approximation. Scripts
  send the body in the `content` form field; put-files upload the content as the
  `file` part. (Read/delete/drift were already working.)
- NG-SIEM Saved Queries and Dashboards: the multipart capability is now available,
  but wiring their `yaml_template` upload still needs the exact template schema +
  `search_domain` value confirmed on a live tenant — noted in their deploy headers.

## 1.12.0 — 2026-07-27

### Added
- **Phase 5 — eleven config types across five families**, completing the roadmap:
  - **Firewall** — Rule Group (rules) and Policy (rule-group assignment; reuses the
    shared policy adapter + fwmgr).
  - **Response & RTR** — RTR Custom Scripts and Put-Files (reusable RTR assets).
  - **IT Automation** (Falcon for IT) — Policy, Task (osquery/scripts), Scheduled Task.
  - **Counter Adversary Ops** — Recon Monitoring Rules (+ notification actions).
  - **Platform Administration** — Installation Tokens (drift-corrected via revoke,
    not delete) and Users (with role-grant as a separate step).
  - **Identity Protection** — IDP Policy Rules (no PATCH API → replace-in-place).
- MSSP / Flight Control is intentionally deferred (multi-tenant, requires parent-CID
  credentials).

## 1.11.0 — 2026-07-27

### Added
- **Next-Gen SIEM** — a new sidebar group with six configuration types:
  - **Correlation Rule** — CQL detection rules (schedule, severity, MITRE mapping,
    notifications, publish), on `/correlation-rules/`.
  - **Parser** — log-normalization parsers, **Saved Query** / scheduled search,
    **Dashboard**, **Lookup File** (CSV enrichment), and **Data Connection**
    (ingest connectors; tokens handled as secrets) on `/ngsiem-content/`.
- Correlation rules reuse `lib/entityAdapter.ts` (+ a publish call); the
  `/ngsiem-content/` types use the collection's template-split CRUD directly.

## 1.10.0 — 2026-07-27

### Added
- **Cloud Security** — a new sidebar group with ten configuration types across the
  Falcon Cloud Security surface:
  - `/cloud-policies/` family: **Custom Configuration (IOM) Rule** (Rego logic),
    **Suppression Rule**, **Rule Override**, **Compliance Framework**, **Compliance
    Control** (+ rule assignments).
  - **Cloud Group** (asset grouping), **Account Registration** (AWS/Azure/GCP),
    **Image Assessment Policy**, **Registry Connection**, **Kubernetes Admission
    (KAC) Policy**.
- Shared generic `lib/entityAdapter.ts` (query→get→CRUD by configurable identity)
  powering the `/cloud-policies/` family + Cloud Groups; the bespoke registration /
  image-assessment / registry / KAC types call the Falcon client directly.

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
