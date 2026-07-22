# Changelog

All notable changes to the Cloudflare app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Cloudflare object (DNS records, WAF custom / rate-limiting / redirect /
  transform rules, managed-ruleset deployments, zone settings, Lists, and Zero
  Trust Access applications/groups/policies/service-tokens and Gateway
  policies/lists), each reported difference is now annotated with the person who
  made the last manual change and when, resolved from the Cloudflare **Audit
  Logs**. The platform stores the `actor` on each diff and the drift view renders
  it, so a drift alert answers *who* and *when*, not just *what*.
  - Attribution queries the account audit logs once per drifted object
    (`GET /accounts/{account_id}/audit_logs?since=<~7d>&per_page=50&direction=desc`)
    and correlates entries CLIENT-SIDE to the drifted object by `resource.id`
    (the live object id, or the setting key for zone settings).
  - It picks the most recent **human** actor (`actor.type === "user"` with an
    email), preferring change-type actions (`create`, `update`, `delete`, `add`,
    `disable`, …) and falling back to the most recent human event otherwise.
    `name`/`email` come from `actor.email`, the timestamp from `when`, and the
    event type from `action.type`.
  - Veltrix's own deploys run through the connection's API token, so a change WE
    made is excluded via the connection login — the attribution reflects the
    *manual* change rather than our deploy. A non-user API-token actor is already
    filtered out by the human check.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, a non-OK response (for example when the API token lacks
    **Audit Logs Read** scope), an empty log, or no usable human event, the diff
    is reported without an actor and the drift view shows "—". It never
    fabricates. Only objects that actually drifted are attributed (one audit
    query per drifted object).

## 1.1.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 5 collapsible sections — Zone, WAF
  & Security, Rules & Lists, Zero Trust · Access, and Zero Trust · Gateway — so
  all 14 configuration types stay navigable. Sections collapse by default,
  remember whether you left them open, and always expand the one you're
  currently working in.
