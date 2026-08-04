# Proofpoint Essentials (Veltrix app)

Manage **Proofpoint Essentials** email security configuration as code through the
**Essentials Interface API (v1)**. Authoring happens in the Veltrix Configuration
Canvas; every change is applied by the Security-as-Code pipeline (validate →
deploy → health check → drift detect → rollback).

> Scope note: Proofpoint's TAP / SIEM / People / Forensics APIs return **read-only
> threat data**, not configuration; Proofpoint Threat Response / TRAP (auto-pull
> quarantine, incident/list management) and the on-prem Protection Server are
> **separate products** with their own consoles, hosts and auth models — see
> [Coverage](#coverage-v120) below for why they stay out of this app. This app
> targets the Essentials Interface API, a real CRUD configuration surface for
> the Essentials (SMB-tier, SaaS) product specifically. It manages the
> declarative *security-config* surfaces the Interface API exposes. (User
> provisioning, which requires a password on create and is unsafe to reconcile
> declaratively, is intentionally out of scope — see Coverage.)
>
> API-maturity note: the Essentials Interface API exposes URL Defense and
> Attachment Defense only as **on/off feature toggles** on the features resource —
> not their granular policy settings (e.g. URL-rewrite behavior, sandbox actions,
> spam thresholds), which are UI-only. There is likewise **no filter-policy/rule
> CRUD endpoint** in the Interface API; the only filter-related API surfaces are
> the sender lists and the Email Tagging settings below. Those other granular
> areas are therefore not managed as code.

## Configuration types

| Type | Manages | API | Reconciliation |
| --- | --- | --- | --- |
| **Proofpoint Domains** (`pp-domains`) | Protected domains + inbound mail routing (`is_active`, relay delivery + `destination`, `failovers`) | `/orgs/{org}/domains` (GET/POST/PUT/DELETE) | Upsert keyed on the domain name; domains it didn't declare are never touched |
| **Proofpoint Sender Lists** (`pp-sender-lists`) | Safe (allow) and Blocked (deny) sender entries, scoped to the organization, a user or a group | The dedicated sender-lists resource, `/orgs/{org}/sender-lists` (and `/users/{email}/sender-lists`, `/groups/{id}/sender-lists`) — GET / PATCH | Additive by (scope, sender) value; rollback PATCHes the exact prior array back |
| **Proofpoint Organization Features** (`pp-org-features`) | Organization security/protection features — URL Defense, Attachment Defense (+ sandboxing), DLP, Encryption, Anti-Spoofing, Email Warning Tags, remediation, etc. | The features resource `/orgs/{org}/features` (GET → modify → PUT) | Upsert keyed on the feature name; read-modify-write preserves undeclared features; rollback restores prior values |
| **Proofpoint Authentication Settings** (`pp-authentication-settings`) | Organization-wide MFA policy and Login/SSO policy (allow local/Azure login, force Azure login, forced-SSO IDP) | `/orgs/{org}/authentication/settings/mfa` and `.../login` (GET/PUT) | Singleton; always declares the full managed state; rollback restores the prior objects |
| **Proofpoint Identity Providers** (`pp-identity-providers`) | SAML SSO Identity Providers (entity id, login/logout URLs, public certificate) | `/orgs/{org}/authentication/settings/idps` (GET/POST list+create) and `.../idps/{uuid}` (GET/PUT/DELETE) | Upsert keyed on the IDP name; rollback deletes a created IDP or restores a prior one |
| **Proofpoint Email Tagging** (`pp-email-tagging`) | Granular Email Warning Tag and Email Subject Tag settings (which conditions tag mail, banner/subject text) | `/orgs/{org}/email-tagging` (GET/PUT) | Singleton; always declares the full managed state; rollback restores the prior object |
| **Proofpoint Email Tagging Exemptions** (`pp-email-tagging-exemptions`) | Senders that Email Tagging should never tag | `/orgs/{org}/email-tagging/exemptions` (GET/POST/DELETE) | Additive by sender value; rollback removes exactly what deploy added |

## Authentication

Proofpoint Essentials authenticates with an **Organization Admin** or **Channel
Admin** account (which must **not** be read-only). The account's email and
password are sent on every request as the `X-User` and `X-Password` headers.

Store them as a Veltrix connection (Username & password auth):

- **Admin email** (Username) → the admin's full email address
- **Password** → the admin account password
- **Endpoint** → your Essentials data-region stack host, e.g. `us1.proofpointessentials.com` (`us1`–`us5` or `eu1`)

## Setup

1. Create/identify a non-read-only Org/Channel Admin in Proofpoint Essentials.
2. Add a connection with the admin email + password and the stack host as endpoint
   (Connections page), and run the per-row connectivity test.
3. Register a **`proofpoint`** component whose hostname is the stack host, and
   attach the credential.
4. Set the **Organization (primary domain)** app setting to the primary domain of
   the organization you manage (e.g. `acme.com`). All changes apply to
   `/orgs/<that-domain>`.

## Notes

- The base URL is `https://<stack>.proofpointessentials.com/api/v1`.
- Sender lists are read/PATCHed through the dedicated `sender-lists` sub-resource
  (organization, user or group scoped) — each scope's PATCH only replaces the
  list(s) it touches, so unrelated lists and scopes are always preserved.
- App settings are only populated in sandbox runs; in production the org is
  resolved from the same setting on the installation — keep the **Organization**
  setting filled in.

## Development

```
cd apps/proofpoint
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs proofpoint            # run handler tests
node ../../scripts/validate-app.mjs apps/proofpoint     # validate against the app contract
```

## Coverage (v1.2.0)

Coverage was (re-)audited against the live Essentials Interface API OpenAPI
document, fetched directly from a running stack
(`https://us1.proofpointessentials.com/apidocs/apidocs/docs`, linked from
`/api/v1/docs/specification.php`; re-checked 2026-08-04) — the authoritative,
current source, superseding the older static HTML overview page at
`/api/v1/docs/index.php` where the two disagree.

### Managed declarative configuration

| Configuration type | Essentials Interface API operations |
| --- | --- |
| Domains | list/create `/orgs/{org}/domains`; get/update/delete `/orgs/{org}/domains/{name}` |
| Sender Lists (org/user/group) | get/PATCH `/orgs/{org}/sender-lists`, `/orgs/{org}/users/{email}/sender-lists`, `/orgs/{org}/groups/{id}/sender-lists` |
| Organization Features | get/PUT `/orgs/{org}/features` |
| Authentication Settings (MFA + Login/SSO) | get/PUT `/orgs/{org}/authentication/settings/mfa`, get/PUT `/orgs/{org}/authentication/settings/login` |
| Identity Providers (SSO) | list/create `/orgs/{org}/authentication/settings/idps`; get/update/delete `.../idps/{uuid}` |
| Email Tagging (Warning + Subject tags) | get/PUT `/orgs/{org}/email-tagging` |
| Email Tagging Exemptions | get/create/delete `/orgs/{org}/email-tagging/exemptions` |

### Fixed in v1.2.0

- **Sender Lists (organization scope) was writing the wrong resource.** The
  prior implementation reconciled the organization scope with a
  read-modify-write `PUT /orgs/{org}` using field names `allow_list`/
  `block_list`. Re-verified against the live OpenAPI document: the
  `Organization` resource's actual sender-list fields are named
  `safe_list_senders`/`block_list_senders` (not `allow_list`/`block_list`), and
  `/orgs/{org}` no longer documents a `PUT` method at all (only
  `GET`/`DELETE`/`PATCH`). `allow_list`/`block_list` belong to the dedicated
  `/orgs/{org}/sender-lists` resource used now. This was a wire-mapping defect
  in the org scope specifically — fixed by moving to the correct, dedicated
  endpoint (which also unlocked the new user/group scopes, since all three
  share the same resource shape).

### Newly added in v1.2.0

- **Sender Lists**: extended from organization-only to also cover **user** and
  **group** scoped Safe/Blocked overrides (the same API resource, addressed at
  `/users/{email}/...` or `/groups/{id}/...`). The user/group must already
  exist in Essentials — this config type does not create them.
- **Authentication Settings**: the organization-wide MFA policy and Login/SSO
  policy, previously entirely unmanaged.
- **Identity Providers**: full SAML SSO IDP CRUD. Every field is public SAML
  metadata (entity id, login/logout URLs, the IDP's own verification
  certificate) — no secret is ever sent or stored by this config type.
- **Email Tagging**: the granular Email Warning Tag / Email Subject Tag
  settings (which conditions tag mail, the banner/subject text) — more
  detailed than the on/off `email_warning_tags` toggle already managed by
  `pp-org-features`, which remains a simple master switch.
- **Email Tagging Exemptions**: the sender allow-list that Email Tagging skips.

### Intentionally excluded

- **Users** (`/orgs/{org}/users`): creating a user accepts a `password` field
  and end users are billable/licensed resources — reconciling user identities
  declaratively (create/update/delete, license consumption) is a materially
  different, higher-blast-radius problem than the configuration surfaces above
  and is out of scope for this app, matching the original v1.0 scope decision.
- **DKIM keypairs** (`/orgs/{org}/domains/{domain}/dkim/{selector}`): creating a
  keypair requires the caller to supply the **private signing key** in the
  request body. Storing cryptographic private key material inside canvas
  config (which may be diffed, logged or displayed) is a secret-management
  antipattern this platform avoids everywhere else via the Credential Vault —
  DKIM keys are not a fit for canvas-based config-as-code.
- **Azure AD Sync Settings** (`/orgs/{org}/settings/azure`, `.../exemptions`):
  the settings object requires an Azure AD application client secret
  (`ad_key`, write-only/masked on read) and this platform already has a
  dedicated, purpose-built Microsoft Entra ID app for Azure AD/Entra
  administration — bolting a second, secret-bearing Azure integration onto the
  Essentials-scoped credential/component model here would duplicate that
  surface unsafely.
- **Package / Licensing** (`/orgs/{org}/package`, `/orgs/{org}/licensing`):
  these change the organization's commercial subscription tier and license
  seat count (`is_eula_confirmed`, `is_activated`, `is_trial_extended`,
  licensing package enum) — a billing/procurement action, not a security
  configuration, and out of scope for the same reason Cisco Meraki excludes
  organization licensing.
- **Reporting / Billing / Stats** (`/reporting/...`, `/billing/...`,
  `/stats/...`) and **`/me`, `/endpoints/{domain}`, `/token/{domain}`**: all
  read-only or session/impersonation-token endpoints, not configuration.
- **Products** (`/orgs/{org}/products`): purchasing/updating a product
  subscription is a billing action ("NOTE this will not normally be available
  to customers" per the API's own description), not security config.
- **Domain verify / health / DKIM-verify actions**
  (`.../verify/{method}`, `.../health`, `.../dkim/{selector}/verify`):
  imperative diagnostic/action endpoints, not durable desired state.
- **Proofpoint Threat Response / TRAP, the Proofpoint Protection Server
  (on-prem MTA) and every other Proofpoint product** (TAP, NPRE, Isolation,
  PSAT, CASB, ITM, ET Intelligence, Secure Email Relay, ...): each is a
  genuinely separate product with its own console, host and authentication
  model — TRAP/PTR's own extensibility docs (list management, incident API,
  CLEAR dispositions) describe a REST API entirely distinct from the
  Essentials Interface API this app targets, and this codebase's convention is
  one app per distinct product surface (e.g. the four separate Microsoft apps
  for Intune/Sentinel/Entra/Defender, rather than one "microsoft" app). Adding
  TRAP/PPS here would mean bolting a second credential/component/connection
  model onto an app whose entire identity (branding, settings, Connections
  page) is Essentials-specific. A TRAP or PPS integration is a candidate for
  its **own** future app, not a retrofit of this one.

Primary reference: the live Essentials Interface API OpenAPI document (path
above). Secondary: the static overview at
`https://{stack}.proofpointessentials.com/api/v1/docs/index.php` and
help.proofpoint.com's Essentials API pages, where publicly reachable.
