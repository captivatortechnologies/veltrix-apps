# Changelog

All notable changes to the Cloudflare app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.5.0 — 2026-08-05

### Added
Research pass against the current Cloudflare API v4 (`api.cloudflare.com`, cross-
checked against Cloudflare's own OpenAPI schema) to close five genuine gaps in
the app's declarative security surface — all newly added config types, wired
into their sidebar groups:

- **Cloudflare Access Identity Providers** (`cloudflare-access-identity-providers`,
  **Zero Trust · Access**). Zero Trust Access identity providers
  (`/accounts/{account_id}/access/identity_providers`) — the login backends an
  Access application's `allowed_idps` and an Access policy's `login_method` rule
  reference by id, which this app had no way to manage until now. Reconciled by
  name across the 15 supported provider types (Azure AD, Okta, generic OIDC,
  SAML 2.0, Google, GitHub, One-Time PIN, ...); provider-specific `config` is a
  JSON object (the same "advanced JSON" convention `app_json` / `rule_json` use
  elsewhere). `client_secret` and equivalent fields are write-only — Cloudflare
  marks them `x-sensitive` and never echoes them back — so drift reports
  presence + type only, never a value diff of the config.
- **Cloudflare Device Posture Rules** (`cloudflare-device-posture-rules`,
  **Zero Trust · Access**). Zero Trust device posture rules
  (`/accounts/{account_id}/devices/posture`) — referenced by an Access policy's
  `device_posture` rule and a Gateway policy's `identity.device_posture`, both
  previously pointing at rules this app couldn't create. Reconciled by name
  across ~20 check types (OS version, disk encryption, domain-joined, and EDR
  vendor integrations — CrowdStrike, SentinelOne, Tanium, Intune, Kolide, ...);
  the type-specific `input` object is a JSON field, following the same
  discriminated-union-as-JSON approach Access applications use for `app_json`.
- **Cloudflare Turnstile Widgets** (`cloudflare-turnstile-widgets`,
  **WAF & Security**). Cloudflare's CAPTCHA replacement
  (`/accounts/{account_id}/challenges/widgets`) — mode, domains, bot-fight-mode,
  region, clearance level and branding options, reconciled by name. The
  generated `secret` is write-only (shown once at creation, redacted by
  Cloudflare on every read after) and is treated exactly like an Access service
  token's client secret: never read back, diffed or stored — only the
  server-assigned `sitekey` is kept, to address and delete the widget.
- **Cloudflare Bot Management** (`cloudflare-bot-management`, **WAF & Security**).
  The zone's Bot Management configuration (`/zones/{zone_id}/bot_management`) —
  a singleton read (GET) then updated (PUT), like zone settings, but a distinct
  endpoint/schema (not one of the `/settings/{id}` keys that type already
  covers). Exposes the "Shared Config" fields valid on every plan (AI bot/
  crawler blocking, content-bot blocking, JS detections, latest-model opt-in)
  directly, plus an `advanced_json` merge field for plan-gated fields (Bot Fight
  Mode, Super Bot Fight Mode, the Enterprise subscription's session-score/
  auto-update/cookie controls) — deploy reads the current live object, merges
  the declared fields on top, and PUTs the merged result so unmanaged /
  plan-inapplicable fields are never reset.
- **Cloudflare Access mTLS Certificates** (`cloudflare-access-mtls-certificates`,
  **Zero Trust · Access**). The root CA certificate an Access policy's
  `certificate` rule validates a user's client certificate against
  (`/accounts/{account_id}/access/certificates`) — the certificate-auth
  counterpart to identity providers, and (unlike a client mTLS identity) a
  PUBLIC CA cert with no private key involved. Reconciled by name. Cloudflare's
  API makes the PEM content immutable after creation (`PUT` accepts only
  `name`/`associated_hostnames`) and never echoes it back on `GET` — an honest,
  documented limitation rather than a worked-around one; rotating a
  certificate's content means adding a new item.

### Notes on scope (researched, not added)
- **IP Access Rules** (`/zones|accounts/.../firewall/access_rules/rules`) —
  still live on every plan, but Cloudflare's own docs say "create custom rules
  instead of IP Access rules" for IP/geography blocking; this app's existing
  WAF Custom Rules + Lists (`ip` kind) already cover that ground on the
  Rulesets engine Cloudflare is steering customers toward. Adding the legacy
  mechanism alongside would duplicate, not extend, existing coverage.
- **DLP profiles** (`/accounts/{account_id}/dlp/profiles`) — a genuine
  Enterprise-add-on security surface, but its `entries` sub-schema is a deep
  discriminated union (pattern-match / predefined / exact-data / word-list /
  document-fingerprint, each with its own detection config) that Cloudflare's
  own official Terraform provider schema flags as `x-stainless-skip:
  ["terraform"]` — i.e. even the reference IaC tool doesn't fully model it.
  Left for a dedicated future pass rather than a shallow partial import here.
- **mTLS Certificates (general)** (`/accounts/{account_id}/mtls_certificates`),
  **origin TLS client auth**, and **zone client certificates** — all can
  require uploading a private key (mTLS *identity*, not just a validating CA),
  which this app's existing write-only-secret handling is built for but which
  sit outside this pass's security-policy scope (they're origin/CDN
  connectivity certificate management, not WAF/Zero Trust policy).
- **Custom Pages** (block/challenge page branding) — cosmetic (which hosted
  HTML page a challenge shows), not a security control in itself; out of scope
  for a security-config-as-code surface.
- **Notification/alerting policies** (`/accounts/{account_id}/alerting/v3/...`)
  — genuinely useful, but an operational-notification surface (who gets paged),
  not a declarative security control; a better fit for a future
  observability-focused pass than this one.

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
