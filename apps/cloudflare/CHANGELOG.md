# Changelog

All notable changes to the Cloudflare app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-07-26

### Added
- **Manage classic Page Rules as code** (new "Cloudflare Page Rules (Legacy)"
  configuration type, in the **Rules & Lists** group). Declares Cloudflare's
  classic Page Rules through the v4 API (`GET/POST/PUT/DELETE
  /zones/{zone_id}/pagerules`), reconciled by their **URL match pattern** — the
  rule's natural identity, since Cloudflare assigns the server id. Each rule is a
  single `url` target (operator `matches`) plus a JSON array of actions; a
  re-deploy updates the matching rule in place (`PUT` by id) or creates it, and
  deploy captures the prior rule bodies so rollback restores updates and deletes
  creates. Includes validation (unique URL pattern; actions must be a non-empty
  JSON array of `{id, value}` objects; a `forwarding_url` action can't be combined
  with setting overrides), health check, drift detection with audit attribution
  (missing rule, status/priority/action-set changes), and the shared **Domain**
  picker like the other zone-scoped types.
  - **Why still ship a deprecated feature?** Cloudflare has deprecated Page Rules
    in favour of the Rulesets engine, but — unlike the Firewall Rules and Rate
    Limiting APIs (sunset 2025-06-15) — the Page Rules API is **not** on the
    "no longer supported" list: existing rules keep working and Cloudflare will
    auto-migrate them "in late 2025 or beyond" with advance notice. There is no
    single Rulesets successor (Page Rules split across Configuration, Cache,
    Origin, Compression Rules and Redirects), and this app implements only the
    Redirect and Transform successors — so this type lets teams keep the Page
    Rules a zone still relies on under configuration-as-code (drift, rollback,
    audit) through the transition. **Prefer the Redirect / Transform types for new
    work.**

## 1.3.0 — 2026-07-25

### Added
- **Pick the target domain inside the form.** Zone-scoped config types (DNS
  records, WAF custom rules, rate-limiting, redirect, transform, managed
  rulesets, zone settings) now start with a **Domain** picker populated live from
  the connected account's zones (Cloudflare `GET /zones`). You choose the
  domain(s) the config applies to, then fill in the rest — instead of baking one
  zone into the connection endpoint and needing a separate connection per domain.
  A config can target **multiple** domains and the deploy fans out across them.
  - One connection now represents a Cloudflare **account** (API token + Account
    ID); the zone is chosen per config.
  - Backward compatible: a config with no domain selected still deploys against
    the connection's registered zone component (the previous behavior).
  - New shared `zones` options provider (`config-types/lib/cloudflareOptions.ts`)
    lists the account's zones; wired into all 7 zone-scoped types. Account-scoped
    types (Access, Gateway, Lists) are unchanged — they act on the whole account.

## 1.2.4 — 2026-07-25

### Changed
- **Clearer error when a connection endpoint isn't a zone.** Zone-scoped types (DNS, WAF, Rate Limiting, Redirect/Transform, Zone Settings) resolve the zone from the connection endpoint. When the endpoint is Cloudflare's own host (`api.cloudflare.com` / `dash.cloudflare.com`) the zone lookup returns nothing; the error now says so explicitly and tells you to set the endpoint to your zone's apex domain (e.g. `example.com`). The generic "no zone found" message likewise now names the fix.

## 1.2.3 — 2026-07-25

### Fixed
- **Saved connections now register as deploy targets** ("Register a cloudflare zone connection…" no longer shows when one exists). The Connections page didn't pass a `componentType`, so a saved connection created only a credential — never a `cloudflare-zone` component — and configs saw no registered connection. It now declares `componentType: cloudflare-zone`, so saving a connection registers a `cloudflare-zone` component tagged with the selected environment, which the config picks up. (Pairs with the platform change to link connections by the config's environment.)

## 1.2.2 — 2026-07-25

### Added
- **Account ID is now entered on the connection itself.** The Add-connection form's identifier field is relabeled **"Account ID"** for Cloudflare (stored on the connection), so an account-scoped token carries its account with it. The client reads the account id most-specific-first: the connection's Account ID, then the app-level `account_id` setting, then derived from the zone. This makes the connection self-contained (the test and account-scoped config types — Access, Gateway, Lists — work without a separate app setting).

## 1.2.1 — 2026-07-25

### Fixed
- **Connection test now works with account-scoped API tokens.** The token verify probe called only `GET /user/tokens/verify`, which an **account-owned** token (created under Account → API Tokens) is rejected by (HTTP 401) — so a valid account-scoped token showed "Cloudflare rejected the API token (HTTP 401)". `verifyToken` now falls back to `GET /accounts/{id}/tokens/verify` when the user endpoint rejects the token and an account id is available (the `account_id` app setting, or derived from the zone). The 401 message also points to the `account_id` setting for account-scoped tokens.

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
