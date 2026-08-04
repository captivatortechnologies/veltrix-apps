# Auth0 (Veltrix app)

Manage **Auth0** — the Okta-owned enterprise identity platform — as code across
the full declarative surface of the **Auth0 Management API v2**. Author
Applications, Connections, Resource Servers, Roles, Client Grants,
Organizations, Actions, Log Streams, Email Templates & Provider, Attack
Protection, MFA (Guardian), Branding & Login Experience, Tenant Settings and
Custom Domains in the Configuration Canvas and drive them through the
Security-as-Code pipeline — validate → deploy → health check → drift detection
→ rollback.

- **Category:** IAM
- **Component type:** `auth0-tenant`
- **Config types:** 15 (see the table below, or [Coverage](#coverage-v030) for the full audit)

| Group | Config type | What it manages |
| --- | --- | --- |
| Applications | `clients` | Applications (Clients) — SPA / native / regular web / M2M |
| Authentication | `connections` | Connections (identity providers) |
| APIs | `resource-servers` | Resource Servers (APIs) — audience, scopes, token settings |
| Authorization | `roles` | RBAC Roles and their API permissions |
| Authorization | `client-grants` | Client Grants — M2M Application ↔ API authorization |
| Organizations | `organizations` | Organizations — branding, metadata, enabled connections |
| Extensibility | `actions` | Actions — custom Node.js code bound to a trigger |
| Logging | `log-streams` | Log Streams — tenant logs to an external sink |
| Communications | `email-templates` | Email Templates — the fixed set of built-in transactional emails |
| Communications | `email-provider` | Email Provider — outbound email transport + credentials |
| Security | `attack-protection` | Attack Protection — breached-password / brute-force / suspicious-IP |
| Security | `mfa-factors` | MFA (Guardian) policy and per-factor toggles |
| Branding | `branding` | Universal Login branding, login experience, custom login page |
| Tenant | `tenant-settings` | Curated tenant settings + a documented feature-flag allowlist |
| Tenant | `custom-domains` | Custom Domains for Universal Login |

## How it connects

Auth0 is reached over HTTPS at the tenant's Management API base
`https://<tenant-domain>/api/v2/`. Authentication is a Management API access
token minted per operation via the OAuth2 **client-credentials** grant:

```
POST https://<tenant-domain>/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id=<M2M client id>
client_secret=<M2M client secret>
audience=https://<tenant-domain>/api/v2/
```

The response `access_token` (a Bearer JWT, ~24h lifetime) is then sent as
`Authorization: Bearer <access_token>` on every Management API call. This is
implemented once, in `lib/auth0Api.ts`, and reused by every config type — no
handler mints its own token differently or talks to a different base URL.

### Required credential

Create a **Machine to Machine** application in Auth0, authorized for the
**Auth0 Management API**. Store it as a Veltrix connection: **endpoint** =
tenant domain (e.g. `acme.us.auth0.com`), **Client ID** = the M2M
application's Client ID, **Client Secret** = its Client Secret.

Grant the scopes for whichever config types you plan to use — the read scope
alone is enough for health checks and drift detection; deploy needs the
create/update/delete scopes too:

| Config type | Scopes |
| --- | --- |
| Applications (Clients) | `read:clients`, `create:clients`, `update:clients`, `delete:clients` |
| Connections | `read:connections`, `create:connections`, `update:connections`, `delete:connections` |
| Resource Servers (APIs) | `read:resource_servers`, `create:resource_servers`, `update:resource_servers`, `delete:resource_servers` |
| Roles | `read:roles`, `create:roles`, `update:roles`, `delete:roles`, `create:role_permissions`, `delete:role_permissions` |
| Client Grants | `read:client_grants`, `create:client_grants`, `update:client_grants`, `delete:client_grants` |
| Organizations | `read:organizations`, `create:organizations`, `update:organizations`, `delete:organizations`, `read:organizations_summary`, `create:organization_connections`, `update:organization_connections`, `delete:organization_connections` |
| Actions | `read:actions`, `create:actions`, `update:actions`, `delete:actions` |
| Log Streams | `read:log_streams`, `create:log_streams`, `update:log_streams`, `delete:log_streams` |
| Email Templates | `read:email_templates`, `create:email_templates`, `update:email_templates` |
| Email Provider | `read:email_provider`, `create:email_provider`, `update:email_provider`, `delete:email_provider` |
| Attack Protection | `read:attack_protection`, `update:attack_protection` |
| MFA Factors | `read:mfa_policies`, `update:mfa_policies`, `read:guardian_factors`, `update:guardian_factors` |
| Branding & Login Experience | `read:branding`, `update:branding`, `read:prompts`, `update:prompts` |
| Tenant Settings | `read:tenant_settings`, `update:tenant_settings` |
| Custom Domains | `read:custom_domains`, `create:custom_domains`, `update:custom_domains`, `delete:custom_domains` |

## Pipeline handlers — the shared conventions

Every config type wires the same six handlers (`validate`, `deploy`,
`rollback`, `healthCheck`, `driftDetect`, `getStatus`) over the shared HTTP/token
plumbing in `lib/auth0Api.ts` and the shared field readers in `lib/fields.ts`.
A few conventions repeat across all fifteen rather than being re-explained per
type:

- **Upsert by identity, not by Auth0's server-assigned id.** The Management
  API keys most resources on an id that doesn't exist until the resource is
  created, so every list-shaped config type lists the live resources, matches
  one by a stable human identity (name, domain, template name, or — for
  Client Grants, which has no single unique field — the composite
  `(client_id, audience)` pair), and `PATCH`es it if found or `POST`s a new
  one if not. That identity field is always immutable: sent on create, omitted
  from every later update.
- **Tenant-wide singletons declare `repeatable: false`.** Attack Protection,
  MFA Factors, Branding & Login Experience and Tenant Settings each describe
  exactly one live object per tenant — the canvas item has no identity field
  and `validate.ts` rejects a second declared item.
- **A blank field means "don't touch it," never "clear it."** Every optional
  field on a singleton config type is omitted from the request body when left
  blank, so combining several singleton config types on one canvas (or
  layering this app under another tool that also manages tenant settings)
  never clobbers a setting nobody asked to change.
- **Auth0-masked secrets are excluded from drift and never rewound by
  rollback.** Connections' `options`, Log Streams' `sink`, Email Provider's
  `credentials` and Actions' `secrets` all contain write-only fields Auth0
  never returns in full on a read. `lib/fields.ts`'s `stripSecretKeys` /
  `SECRET_LIKE_KEY` filters those keys out of every drift comparison and every
  rollback snapshot — re-declare a secret's value if you need to roll back to
  an exact prior one.
- **List pagination is one shared loop.** `lib/auth0Api.ts`'s `listAllPages`
  walks every offset-paginated list endpoint the same way. The two exceptions
  are documented where they diverge: Custom Domains' list is not paginated at
  all, and Actions' list returns a wrapped `{ actions, total }` page instead of
  a raw array (see `config-types/actions/network.ts`).

## Development

```
cd apps/auth0
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs auth0                 # run handler tests
node ../../scripts/validate-app.mjs apps/auth0         # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against the official Auth0 Management API v2 documentation
(`https://auth0.com/docs/api/management/v2/`) and cross-checked against the
`auth0/terraform-provider-auth0` resource schemas, current as of 2026-08-04.

### Managed declarative configuration

| Configuration type | Management API operations | Upsert identity |
| --- | --- | --- |
| Applications (Clients) | `GET`/`POST /clients`, `PATCH`/`DELETE /clients/{id}` | name |
| Connections | `GET`/`POST /connections`, `PATCH`/`DELETE /connections/{id}` | name (strategy immutable) |
| Resource Servers (APIs) | `GET`/`POST /resource-servers`, `PATCH`/`DELETE /resource-servers/{id}` | name (identifier immutable) |
| Roles | `GET`/`POST /roles`, `PATCH`/`DELETE /roles/{id}` + `/roles/{id}/permissions` | name |
| Client Grants | `GET`/`POST /client-grants`, `PATCH`/`DELETE /client-grants/{id}` | composite (client_id, audience) |
| Organizations | `GET`/`POST /organizations`, `PATCH`/`DELETE /organizations/{id}` + `/organizations/{id}/enabled_connections` | name |
| Actions | `GET`/`POST /actions/actions`, `PATCH`/`DELETE /actions/actions/{id}`, `POST .../deploy`, `PATCH /actions/triggers/{id}/bindings` | name |
| Log Streams | `GET`/`POST /log-streams`, `PATCH`/`DELETE /log-streams/{id}` | name (type immutable) |
| Email Templates | `GET`/`POST /email-templates`, `PATCH /email-templates/{templateName}` | fixed template name |
| Email Provider | `GET`/`POST`/`PATCH`/`DELETE /emails/provider` | singleton (doesn't exist until configured) |
| Attack Protection | `GET`/`PATCH /attack-protection/breached-password-detection`, `.../brute-force-protection`, `.../suspicious-ip-throttling` | singleton (always exists) |
| MFA Factors | `GET`/`PUT /guardian/policies`, `GET /guardian/factors`, `PUT /guardian/factors/{name}` | singleton (always exists) |
| Branding & Login Experience | `GET`/`PATCH /branding`, `GET`/`PATCH /prompts`, `GET`/`PUT`/`DELETE /branding/templates/universal-login` | singleton (always exists) |
| Tenant Settings | `GET`/`PATCH /tenants/settings` (curated field + flag allowlist) | singleton (always exists) |
| Custom Domains | `GET`/`POST /custom-domains`, `PATCH`/`DELETE /custom-domains/{id}` | domain (type immutable) |

Every list-shaped endpoint is matched by a stable human identity rather than
Auth0's server-assigned id (which doesn't exist before the first deploy);
every singleton is read before it's written so rollback has an exact prior
snapshot to restore.

### Intentionally excluded

- **Rules and Hooks** — both are Auth0-deprecated in favor of Actions ("This
  resource is deprecated. Refer to the guide on how to migrate from hooks/rules
  to actions" per Auth0's own docs). Actions is the config type this app ships
  instead; adding the deprecated APIs alongside their supported replacement
  would just create two ways to do the same thing, one of which Auth0 will
  eventually remove.
- **Rules Configs** (`/rules-configs`) — a key/value secret store that only
  existed to back Rules' legacy `configuration` object. Excluded for the same
  reason as Rules itself; Actions' own `secrets` array is the current
  equivalent.
- **Universal Login custom text per screen/language**
  (`/prompts/{prompt}/custom-text/{language}`) and **prompt partials**
  (`/prompts/{prompt}/partials`) — genuinely declarative, but the
  prompt × language × screen combinatorics (dozens of prompts, every
  supported locale) don't fit a single canvas item or a small repeatable list
  without a much larger, dedicated UI. `branding`'s single custom
  Universal-Login-page HTML field covers the common "we need our own login
  page" case; per-string localization overrides are a good candidate for a
  follow-up config type.
- **Branding Themes** (`/branding/themes`) — the newer Advanced Customization
  (Liquid-based New Universal Login theming) API. Declarative in principle,
  but its schema is large, still evolving, and overlaps with the simpler
  `branding`/`prompts` fields this app already manages; deferred rather than
  shipped half-modeled.
- **Phone Providers** (`/phone-providers`) and **phone notification
  templates** (`/phone/*`) — the SMS/voice analog of Email Provider /
  Templates. Excluded from this release for scope, not principle; a natural
  companion to Email Provider in a follow-up.
- **Self-Service Profiles**, **Forms/Flows** (Auth0's newer low-code
  onboarding and workflow canvases), **Token Exchange Profiles**, **Network
  ACLs**, **Rate Limit Policies**, **Risk Assessments** and **Event Streams**
  (the newer, broader successor to Log Streams for tenant-lifecycle events) —
  all real, current Management API surfaces, but each is either still young
  and evolving, has its own visual builder Auth0 intends operators to use
  directly, or is enough of a distinct feature area (with its own rollback
  and drift semantics) to warrant a dedicated config type rather than being
  squeezed into this release. Candidates for future coverage.
- **Organization Members and Member Roles**
  (`/organizations/{id}/members*`, `.../roles`) — runtime membership data
  (which end users belong to which org, with which roles), not desired-state
  configuration. This app manages an organization's *structure*
  (branding/metadata/enabled connections); who is actually a member is a
  day-to-day operational action, the same category as user management.
- **Encryption Key Manager** (`/keys/encryption`) — tenant root-of-trust key
  rotation. A one-way, irreversible operational action with no meaningful
  rollback, not a piece of desired state to declare.
- **Device Credentials, Blacklisted Tokens, Grants, Users, User Blocks,
  Anomaly IP Blocks** — runtime security/session data (a device's public key,
  a revoked token, a user's active grants, the users themselves, a
  temporarily-blocked login, an auto-blocked IP), not configuration. Managing
  users/grants as "config" would conflate identity data with the identity
  platform's own configuration.
- **Stats, Logs (read), Jobs, and the Custom Domain / connection `verify`
  actions** — read-only telemetry or one-shot imperative actions (send a
  verification email, kick off an import job, prove DNS ownership), not
  durable desired state a canvas can own. Custom Domains' `pending_verification`
  → manual DNS proof → `verify` flow is called out explicitly in that config
  type's own docs as the one manual step this app does not automate.
- **Tenant Settings' full field surface** — `/tenants/settings` exposes far
  more than the curated subset this app manages (session-cookie behavior,
  mTLS, pushed-authorization-request support, sandbox internals, and more).
  The same judgment call this app already makes for Resource Servers' signing
  algorithms and Connections' strategy list: expose the safe, commonly-needed
  fields plus a documented flag allowlist, not every field Auth0 will ever add.

Primary references: the [Auth0 Management API v2 Explorer](https://auth0.com/docs/api/management/v2),
the [Rules-to-Actions](https://auth0.com/docs/customize/actions/migrate/migrate-from-rules-to-actions)
and [Hooks-to-Actions](https://auth0.com/docs/customize/actions/migrate/migrate-from-hooks-to-actions)
migration guides, and each endpoint cited in the header comment of its
config type's `_shared.ts` / `network.ts`.
