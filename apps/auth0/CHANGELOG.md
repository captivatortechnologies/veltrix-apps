# Changelog

All notable changes to the Auth0 app are documented here.

## 0.3.0 — 2026-08-04

Eleven new configuration types, exhausting the Auth0 Management API v2's
declarative config-as-code surface (4 → 15 types), grouped in the sidebar and
sharing two new lib primitives (`listAllPages` pagination, `stripSecretKeys`
secret-key masking) plus a text/HTML transport pair (`getTextOrNull`/`putText`)
for the one endpoint that isn't JSON. See the README's **Coverage** section for
the full managed-vs-excluded audit.

- **Client Grants** (`Authorization` group) — authorize a Machine-to-Machine
  Application (`client_id`) for an API (`audience`) with a scope list, over
  `/client-grants`. Upserts by the composite (client_id, audience) pair — this
  resource has no single unique field.
- **Organizations** (`Organizations` group) — name, display name, branding,
  metadata, third-party client access, token quota and enabled connections,
  over `/organizations` plus the `/organizations/{id}/enabled_connections`
  sub-resource (reconciled the same way Roles reconciles permissions).
- **Actions** (`Extensibility` group) — Node.js code, dependencies, secrets,
  runtime and trigger binding, over `/actions/actions`, its `/deploy`
  sub-resource, and `/actions/triggers/{id}/bindings` (bindings PATCH is
  rebuilt from the live list so every other bound action is left untouched).
  The current, supported replacement for the deprecated Rules and Hooks.
- **Log Streams** (`Logging` group) — stream tenant logs to HTTP, Datadog,
  Splunk, EventBridge, Event Grid, Sumo Logic, Mixpanel or Segment, over
  `/log-streams`. Sink secrets (API keys, tokens) are excluded from drift and
  never rewound on rollback.
- **Email Templates** (`Communications` group) — body, sender, subject and
  behavior for Auth0's fixed set of built-in transactional emails, over
  `/email-templates`. Auth0 has no delete for a template — rollback of a
  newly-customized one can only disable it.
- **Email Provider** (`Communications` group) — the tenant's outbound email
  provider (SES, SMTP, SendGrid, Mailgun, ...) and its write-only credentials,
  over `/emails/provider`. A singleton that doesn't exist until first
  configured (404 vs. a live object determines POST vs. PATCH).
- **Attack Protection** (`Security` group) — Breached Password Detection,
  Brute-force Protection and Suspicious IP Throttling, each authored as the
  exact documented JSON request object, over `/attack-protection/*`.
- **MFA Factors** (`Security` group) — the tenant MFA enforcement policy
  (never / always / adaptive) and per-factor enable/disable toggles (SMS,
  push, OTP, email, Duo, WebAuthn, recovery code), over `/guardian/policies`
  and `/guardian/factors/{name}`.
- **Branding & Login Experience** (`Branding` group) — Universal Login
  branding (logo, colors, font), the New/Classic login-experience prompt
  settings, and an optional custom Classic Universal Login HTML page, over
  `/branding`, `/prompts` and `/branding/templates/universal-login`.
- **Tenant Settings** (`Tenant` group) — a curated, documented subset of
  `/tenants/settings`: identity, sessions, defaults, locales/logout URLs and a
  24-flag allowlist (Auth0 partial-merges `flags`; every other managed field
  is fully declared, same as Applications' URL arrays).
- **Custom Domains** (`Tenant` group) — domain, certificate type, TLS policy
  and metadata, over `/custom-domains`. DNS verification (`POST
  /custom-domains/{id}/verify`) is an imperative, credential-less step this
  config type intentionally does not automate.

All eleven follow the existing upsert-by-identity / immutable-identity-field /
optional-JSON-for-nested-shapes conventions, with validate / deploy / rollback /
health-check / drift-detect / status handlers and a `__tests__` suite per type
(156 new tests; 213 total for the app).

## 0.2.0 — 2026-08-01

Three new configuration types, all over the Auth0 Management API v2 and upserting
by name (list → match by name → PATCH existing / POST new), with rollback,
health-check, drift-detect and status.

- **Connections** config type — Auth0 Connections (identity providers): name,
  strategy, display name, enabled clients and strategy `options` (free-form JSON)
  over `/connections`. `name` and `strategy` are set at creation and omitted from
  the update body (immutable). Secret-bearing option keys (`client_secret`, …) are
  excluded from drift comparison and from the rollback restore body so a live
  secret is never overwritten with Auth0's mask.
- **Resource Servers (APIs)** config type — Auth0 APIs: name, `identifier`
  (audience URI), scopes (authored as value → description pairs), signing algorithm
  and token lifetime over `/resource-servers`. The `identifier` is unique and
  immutable, so it is sent only on create and omitted from the update body.
- **Roles** config type — Auth0 RBAC roles: name, description and assigned API
  permissions over `/roles`, with permissions reconciled through the
  `/roles/{id}/permissions` sub-resource (GET current → POST additions → DELETE
  removals). Rollback restores the prior role body and prior permission grants, or
  deletes a role it created.

> Note: Auth0 marks `enabled_clients` on the connection object as deprecated in
> favour of `PATCH /connections/{id}/clients`; it is still accepted here for
> compatibility.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Applications (Clients)** config type — create / edit / delete Auth0
  applications (name, application type, callback / logout / web-origin URLs, token
  endpoint auth method) over the Auth0 Management API v2, with validate / deploy
  (upsert by client name) / rollback (restore prior fields or delete a created
  client) / health-check / drift-detect / status.
- **Connectivity test** — mints a Management API access token via the OAuth2
  client-credentials grant (`POST /oauth/token`, audience
  `https://<tenant>/api/v2/`) and calls `GET /api/v2/clients?per_page=1`.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (M2M
  application → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for an Auth0 tenant; saving a connection registers
  `auth0-tenant` as a deploy target).

> Auth0's Management API keys clients on the server-assigned `client_id`, so this
> config type upserts by application **name**. The connection stores the
> Machine-to-Machine credential as Client ID (username) + Client Secret (token).
