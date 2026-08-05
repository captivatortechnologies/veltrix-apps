# Mimecast

Manage **Mimecast** configuration as code through the Mimecast API 2.0 — both
the original form-POST `/api/...` surface and the newer, fully-RESTful
`/policy-management/cloud-gateway/v1/...` surface — with validation, drift
detection and rollback handled by the Veltrix Security-as-Code pipeline. See
**[Coverage](#coverage-v060)** below for the full managed-vs-excluded surface,
sourced against Mimecast's current developer portal.

## What it manages

14 configuration types across policies, definitions, sets, groups and managed
URLs — Blocked Senders, Anti-Spoofing (Bypass and, since v0.6.0, the
enforcement policy itself), Address Alteration (policies, sets and
definitions), Directory Profile Groups, Web Security policies, Managed URLs,
Greylisting, Delivery Route (definitions and policies), and DNS Authentication
- Outbound / DKIM (definitions and policies). See
**[Coverage](#coverage-v060)** for the endpoint each one targets.

Most policy types have **no update API on the legacy surface**, so the app
matches a declared item to a live one by its identity (usually its
description) and applies a change as **delete + recreate**, carrying the
pre-management entry forward so rollback can restore it. The six types added
in v0.6.0 target the newer v1 surface, which supports a **real PATCH update**
instead. Reconcile always deletes only items this app itself created.

## Authentication

Mimecast authenticates with an **API 2.0 application** using OAuth2 client
credentials. In the Mimecast Admin Console, register an API 2.0 application with
a role granting the permissions the config types you use need — **Services |
URL Protection | Edit** for Managed URLs, and **Gateway | Policies | Edit**
(read-only operations accept **Gateway | Policies | Read**) for every policy
and definition type, on both the legacy and v1 surfaces — and store the
credential as:

- **Username** → the Client ID
- **Password** → the Client Secret

The app exchanges these for a short-lived Bearer token (`POST /oauth/token`),
refreshing it automatically — the same token is reused for both the legacy
`/api/...` requests and the newer `/policy-management/cloud-gateway/v1/...`
requests. The default base URL is `https://api.services.mimecast.com`;
override it in the app's settings only if your tenant uses a different gateway
host.

## Configuration type: Managed URLs

Each canvas item is one managed URL:

- **URL** — the URL or domain (no fragment `#`).
- **Action** — `block` or `permit`.
- **Match Type** — `explicit` (the whole URL) or `domain`.
- **Comment** — optional.
- **Permit options** — `disableRewrite` / `disableUserAwareness` (permit only),
  `disableLogClick`.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs mimecast

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/mimecast
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## Coverage (v0.6.0)

Coverage was audited against Mimecast's current, actively-maintained developer
portal (`developer.services.mimecast.com`) — the source of truth for what
"Mimecast API 2.0" now covers. The older public API 1.0 reference site
(`integrations.mimecast.com/documentation/...`) has been **retired**: every
endpoint-reference URL there now 301-redirects to a Zendesk support-article
section, confirming it is no longer the current documentation surface. The
developer portal scopes every write endpoint this app targets under a single
**Policy Management** API category, itself split across two generations:

- The **legacy** surface (`/api/policy/*`, `/api/directory/*`, `/api/ttp/url/*`)
  used by this app's original 8 config types — form-POST requests wrapped in
  `{ data: [...] }`, responses shaped `{ meta, data, fail }`, and **no update
  operation** on any resource (a change is applied as delete + recreate).
- The newer **`/policy-management/cloud-gateway/v1/*`** REST surface, added in
  v0.6.0 — real `GET`/`POST`/`PATCH`/`DELETE`, bare JSON bodies, list responses
  uniformly shaped `{ definitions: [...] }` regardless of the resource's own
  name, and — critically — **every resource supports a real PATCH update**, so
  the six v0.6.0 types update a changed item in place instead of deleting and
  recreating it.

### Managed declarative configuration

| Configuration type | Mimecast API | Operations |
| --- | --- | --- |
| Managed URLs | legacy `/api/ttp/url/*` | create / get-all / delete — no update, matched by URL identity |
| Blocked Senders | legacy `/api/policy/blockedsenders/*` | create-policy / get-policy / delete-policy — no update |
| Anti-Spoofing Bypass | legacy `/api/policy/antispoofing-bypass/*` | create-policy / get-policy / delete-policy — no update |
| Address Alteration | legacy `/api/policy/address-alteration/*` | create-policy / get-policy / delete-policy — no update |
| Address Alteration Sets | legacy `/api/policy/address-alteration/*-address-alteration-set` | create / get only — Mimecast has no update/delete-set API; ensure-exists, never pruned |
| Address Alteration Definitions | legacy `/api/policy/address-alteration/*-definition` | create-definition / get-definition / delete-definition — no update; tuple-keyed (no name) |
| Directory Profile Groups | legacy `/api/directory/*` | find-groups / create-group / delete-group + get/add/remove-group-member |
| Web Security Policies | legacy `/api/policy/webwhiteurl/*` | create-policy-with-targets / get-policies / delete-policy — no update |
| **Anti-Spoofing** *(v0.6.0)* | v1 `.../v1/anti-spoofing/policies[/{id}]` | GET / POST / **PATCH** / DELETE |
| **Greylisting** *(v0.6.0)* | v1 `.../v1/greylisting/policies[/{id}]` | GET / POST / **PATCH** / DELETE |
| **Delivery Route Definitions** *(v0.6.0)* | v1 `.../v1/delivery-route/definitions[/{id}]` | GET / POST / **PATCH** / DELETE |
| **Delivery Route Policies** *(v0.6.0)* | v1 `.../v1/delivery-route/policies[/{id}]` | GET / POST / **PATCH** / DELETE |
| **DNS Authentication - Outbound Definitions** *(v0.6.0)* | v1 `.../v1/dns-authentication-outbound/definitions[/{id}]` | GET / POST / **PATCH** / DELETE |
| **DNS Authentication - Outbound Policies** *(v0.6.0)* | v1 `.../v1/dns-authentication-outbound/policies[/{id}]` | GET / POST / **PATCH** / DELETE |

### Newly added in v0.6.0

- **Anti-Spoofing** — the spoofing-check enforcement policy itself, distinct
  from the pre-existing Anti-Spoofing Bypass (which only exempts trusted
  senders from a check already enabled elsewhere). Adds `option`
  (no_action/apply/apply_non_mimecast), `fromPart`, a richer from/to target
  (adds `internal_addresses`/`external_addresses`/`profile_group` to the
  everyone/domain/email-address choices every legacy policy type already has),
  plus `override`, `bidirectional`, `sourceIPs` and `hostnames` scoping.
- **Greylisting** — temporarily defers unrecognized senders; `option`
  (no_action/apply) scoped to a **from** target only — this is the one policy
  type in this app with no recipient ("to") scope, confirmed against the v1
  OpenAPI request schema (no `to` field is defined for it, unlike every other
  policy type here).
- **Delivery Route Definitions** + **Delivery Route Policies** — the
  destination mail server(s) the Mimecast MTA delivers to for matched mail,
  the same definition-then-policy shape as the pre-existing Address Alteration
  Set / Address Alteration pair.
- **DNS Authentication - Outbound Definitions** + **... Policies** — outbound
  DKIM signing per domain. Mimecast **generates and holds the DKIM keypair
  itself**; the create/update payload only ever carries
  `description`/`domain`/`selector`/`signDkim`/`keyLength` — never a private
  key — so this is safe to manage declaratively, unlike a bring-your-own-key
  DKIM integration would be.
- New shared `lib/policyTargetV1.ts` helper for the from/to "policy target"
  shape common to all four new policy types, and a new `requestV1` method plus
  `extractV1List`/`v1ErrorMessage` helpers on `MimecastClient` in
  `lib/mimecast.ts` for the v1 REST surface (reusing the same OAuth2 bearer
  token as the legacy client).

### Notable implementation details

- This app does **not** migrate its original 8 config types to the v1 surface
  in this pass, even though several of them (anti-spoofing-bypass,
  blocked-senders) also exist there. An already-shipped, working
  delete+recreate implementation was not disturbed purely to adopt a nicer API
  shape; the v1 surface is used only for genuinely new declarative surface.
- `address_attribute_value` — one of the seven target types the v1 API's
  `from`/`to` object accepts (matching a custom directory attribute by an
  account-specific attribute id) — is the one target type **not** modeled.
  Every other target type is self-contained (a domain, an email address, a
  directory group id); this one requires knowing an attribute id this app has
  no catalog for and no live picker exists for.

### Intentionally excluded

- **SMTP Authentication on Delivery Route Definitions**
  (`smtpAuthentication`: `authMechanisms` / `username` / **`password`** /
  `domain`) — the create/update payload requires a plaintext password for the
  destination server. This app never sends that field, so an authenticated
  route configured out-of-band (Mimecast Administration Console) is left
  untouched by deploys — the same secret-material boundary this catalog draws
  everywhere else (e.g. Proofpoint's DKIM keypairs, Imperva's custom
  certificates).
- **Delivery Route `verify`** (`POST .../delivery-route/verify`) — a one-shot
  connectivity/TLS check against a hostname:port, not durable desired state.
- **Attachment Protect, URL Protect (TTP definitions), Impersonation Protect,
  Content Examination / DLP, Spam Scanning, Secure Messaging, Connectors.**
  Mimecast's own developer portal scopes its **Policy Management** API
  category explicitly to "Grey listing, delivery route, DNS authentication,
  TTP URL Protect, managed URLs, address alteration, anti-spoofing, anti
  spoofing bypass, blocked senders, and web security" — none of these six
  features are part of that list. Attachment Protect and Impersonation Protect
  do appear under a separate **Security Events** API category, but only as
  read-only event-log retrieval (e.g. "Get TTP Impersonation Protect Logs") —
  not as a configuration write surface. No confirmed write API exists for
  these on the current developer portal; not modeled rather than guessed at.
- **Managed Senders / message tracking / held-message release/reject**
  (the **Email Security Cloud Gateway** API category: "permit/block managed
  senders, find processing messages, hold list summary, message list and
  reject/release"). Held-message release/reject and message tracking are
  one-shot actions on in-flight mail, not durable config — excluded on that
  basis, matching the boundary this catalog draws elsewhere. "Permit/block
  managed senders" specifically reads as a genuinely separate, simpler sender
  allow/block list (distinct from the from/to-scoped Blocked Senders policy
  already managed), but its exact request/response shape was not independently
  confirmed against the OpenAPI schema in this pass — a candidate for a future
  session, not modeled here rather than guessed at.
- **Archive Search, Data Retention, Audit Events, Awareness Training, Human
  Risk, Threat Management/Remediation, DMARC Analyzer, account/domain
  onboarding, Connectors (M365 consent-flow integration).** All read-only
  reporting/analytics, imperative remediation actions, consent-flow
  provisioning, or account onboarding — not steady-state security
  configuration, the same boundary this catalog draws around every other app
  (e.g. Cortex XDR excludes authentication-settings/rbac, Imperva excludes
  sites lifecycle).

Primary references: `developer.services.mimecast.com/apis` (the current API
index — the Policy Management category's own scope statement is quoted
above), `developer.services.mimecast.com/docs/policymanagement/1` (the v1
OpenAPI reference, browsed live for every new type's request/response
schema), and the retired API 1.0 reference
(`integrations.mimecast.com/documentation/endpoint-reference/...`, confirmed
redirecting to Zendesk during this audit) for the pre-existing 8 types' legacy
endpoints.
