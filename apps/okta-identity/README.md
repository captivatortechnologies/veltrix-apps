# Okta

Manage [Okta](https://www.okta.com/) configuration as code through the Okta Management API. Author
configurations in the platform's Configuration Canvas and deploy them through the Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback are handled per configuration
type.

## Credentials

The app authenticates every request with an Okta API token, sent as `Authorization: SSWS <token>`.
Create one in the Okta Admin console under **Security → API → Tokens** — a token inherits the
permissions of the admin who created it, so create it as an admin scoped to what this app manages.
Store it as a Veltrix credential:

| Veltrix credential field | Okta value |
| --- | --- |
| API token | An Okta API token (SSWS) |

Register an **`okta-org`** component whose hostname is your Okta org domain (e.g. `dev-12345.okta.com`
or `acme.oktapreview.com`) and attach the credential.

## What it manages

| Configuration type | Okta object | API |
| --- | --- | --- |
| Policies | Sign-on / password / authenticator-enrollment policies + rules | `/policies` |
| Group Rules | Dynamic group-assignment rules | `/groups/rules` |
| Groups | Groups (OKTA_GROUP) + optional static membership | `/groups` |
| Network Zones | IP / dynamic network zones | `/zones` |
| Trusted Origins | CORS / redirect / iframe-embed allowlist | `/trustedOrigins` |
| Behavior Rules | Behavioral detection rules | `/behaviors` |
| Authenticators | Authenticator config + enablement (no delete) | `/authenticators` |
| Identity Providers | External IdPs (OIDC/SAML/social) — sensitive | `/idps` |
| Event Hooks | Event hooks (delete needs INACTIVE; secret write-only) | `/eventHooks` |
| Inline Hooks | Inline hooks (token/SAML transforms; secret write-only) | `/inlineHooks` |
| Authorization Servers | Custom OAuth authorization servers | `/authorizationServers` |
| Auth Server Scopes | OAuth scopes on an authorization server | `.../scopes` |
| Auth Server Claims | OAuth claims on an authorization server | `.../claims` |
| Auth Server Policies | OAuth access policies + rules | `.../policies` |
| Applications | App integrations (OIDC/SAML/SWA/bookmark) — secrets write-only | `/apps` |
| App Group Assignments | Assign groups to applications | `/apps/{id}/groups` |
| ThreatInsight | Org suspicious-request handling (none/audit/block) + exempt zones (singleton) | `/threats/configuration` |
| Log Streams | System Log export to AWS EventBridge / Splunk Cloud (Splunk token write-only) | `/logStreams` |
| Device Assurance Policies | Per-platform device posture requirements | `/device-assurances` |
| User Types | User type definitions (name immutable; default type protected) | `/meta/types/user` |
| Custom Admin Roles | Least-privilege custom admin roles + permissions | `/iam/roles` |
| Resource Sets | Resource collections that scope custom admin roles | `/iam/resource-sets` |
| Resource Set Bindings | Grant a role to members within a resource set | `.../bindings` |
| Profile Schemas | Custom attributes on user-type / group profile schemas (update-only) | `/meta/schemas` |
| Profile Mappings | Attribute transforms between a source and target profile (update-only merge) | `/mappings` |
| Features | Self-service feature toggles (enable/disable lifecycle; no create/delete) | `/features` |
| CAPTCHA | Org CAPTCHA instance + org-wide enablement (secret key write-only; singleton) | `/captchas`, `/org/captcha` |
| Linked Objects | User linked-object definitions (immutable — delete-and-recreate to change) | `/meta/schemas/user/linkedObjects` |
| Rate Limit Settings | Admin notifications, per-client enforcement, warning threshold (singleton) | `/rate-limit-settings/*` |
| Brands | Brands + their single theme (colors + touchpoint variants; default brand protected) | `/brands`, `.../themes` |
| Custom Domains | Custom login-URL domains + certificates (domain immutable; brand rebindable; MANUAL cert cannot revert) | `/domains`, `.../certificate` |
| Email Domains | Custom email domains (sender name/username; DNS verification is external) | `/email-domains` |
| SMS Templates | Custom SMS templates (SMS_VERIFY_CODE text + localized translations) | `/templates/sms` |

## Okta-specific behaviour the app handles

Okta objects are `id`-keyed with **no upsert**, and several have lifecycle rules the app enforces:

- **No upsert** — a deploy lists the objects, matches by logical key (name/type), and updates in place
  or creates; the Okta `id` is captured for rollback.
- **Group rules must be deactivated before update**, and their `actions` block is immutable — changing
  which groups a rule assigns means delete-and-recreate, which the app does automatically. Rules are
  born inactive and activated explicitly.
- **Network zones can't be deleted while active** (on Identity Engine) or while referenced by a policy
  or rule — the app deactivates first and surfaces reference errors clearly.
- **Built-in objects are never touched**: the default policy per type and its default rule, `BUILT_IN`
  groups (e.g. `Everyone`) and `APP_GROUP` groups, and the system network zones (`LegacyIpZone`,
  `BlockedIpZone`, `DefaultEnhancedDynamicZone`, `DefaultExemptIpZone`) — all update-in-place only,
  never deleted.
- **Group membership is opt-in per group.** Don't manage static membership on a group targeted by a
  group rule — rule-assigned members can't be removed through the membership API and would show as
  permanent drift.
- **Write-only secrets are excluded from drift.** The event-hook auth header value, inline-hook secret,
  IdP/app client secrets and the Splunk log-stream HEC token are never returned by Okta, so they are
  re-sent on deploy where the API allows and never drift-checked. (The log-stream token is additionally
  immutable, so it is sent only at create.)
- **Immutable fields → delete-and-recreate.** A log stream's `type`/`settings`, a device assurance
  policy's `platform`, a user type's `name`, and a custom domain's `domain` string cannot be changed
  after creation; the app resends them unchanged on update and surfaces a clear "delete and recreate"
  error if you change them. A custom domain's certificate source is one-directional: once switched to
  `MANUAL` there is no Okta API to revert it to `OKTA_MANAGED` (delete-and-recreate to go back) — but
  unlike most immutable fields, its **brand IS rebindable** at any time via a dedicated endpoint.
- **Sub-resource reconciliation.** Custom admin role permissions and resource-set resources are only
  accepted in bulk at create time. On update the app diffs the desired set against live and adds/removes
  members one at a time through the role's `/permissions` and the set's `/resources` sub-resources.
- **Delete preconditions are surfaced.** A device assurance policy mapped to an Authentication Policy,
  a user type still assigned to users, and a custom role/resource set still bound to a principal cannot
  be deleted until the reference is removed — the app reports the specific reason on a failed rollback.
- **Protected/system objects are never created or deleted:** the default user type, Okta's standard
  admin roles (`SUPER_ADMIN`, `ORG_ADMIN`, …), and the ThreatInsight singleton (updated in place only).

The complex, per-type parts (password complexity/age/lockout, MFA authenticator settings, policy
rules, zone gateway/ASN definitions) are authored as JSON inside the canvas, since their schema is
large and type-dependent.

## Coverage

This app targets the full **declarative, round-trippable** surface of the Okta Management API — every
object a security/IAM team would reasonably author as code and expect to validate, deploy, diff and
roll back. 34 configuration types, grouped as they appear in the sidebar:

**Policies & Rules** — Policies (sign-on/password/MFA-enrollment + rules), Behavior Rules (velocity,
anomalous location/IP/device), Device Assurance Policies (per-platform posture).

**Authentication** — Authenticators, Identity Providers (OIDC/SAML/social).

**Directory** — Group Rules, Groups (+ opt-in static membership), Users (a controlled, safe-by-design
set — break-glass admins/service accounts, never general workforce provisioning), User Types, Linked
Objects (primary/associated relationships).

**Applications** — Applications (OIDC/SAML/SWA/bookmark), App Group Assignments.

**Authorization Servers** — Authorization Servers, Auth Server Scopes, Auth Server Claims, Auth Server
Policies (+ rules).

**Network & Security** — Network Zones, Trusted Origins, ThreatInsight, CAPTCHA, Rate Limit Settings.

**IAM Governance** — Custom Admin Roles, Resource Sets, Resource Set Bindings.

**Profile & Schema** — Profile Schemas (custom attributes), Profile Mappings, Features (self-service
toggles).

**Integrations** — Event Hooks, Inline Hooks, Log Streams (AWS EventBridge / Splunk Cloud).

**Branding & Notifications** — Brands (+ theme), **Custom Domains** (custom login-URL domain +
certificate — added to close the one verified gap in this pass, see below), Email Domains
(custom mail-sending domain), SMS Templates.

### Intentionally excluded

Surfaces the Okta Management API exposes that this app deliberately does **not** manage as declarative
config, each with why:

| Surface | API | Why excluded |
| --- | --- | --- |
| Org Settings (company profile/contacts) | `/org`, `/org/contacts/{type}`, `/org/preferences/*` | Account/billing metadata (company name, address, support phone, footer visibility), not a security-relevant config-as-code surface — low value relative to the risk of an app writing an org's legal/billing identity. |
| Brand Email Template Customizations | `/brands/{id}/templates/email/{name}/customizations` | Real declarative surface, but dozens of built-in template names × languages is a much larger content-authoring surface than SMS Templates' single template — deferred to a dedicated future pass rather than bolted on here. |
| System Log | `/logs` | Read-only audit trail, not declarative config — nothing to author or diff. Already consumed internally (not as a config type) to attribute drift to "who changed it + when" (see CHANGELOG 1.10.0). |
| API Tokens | `/api/v1/... token issuance is UI/CLI-only` | Secret material returned exactly once at creation and never re-readable; this app's own connection already IS an API token — self-referential and not round-trippable. |
| Devices | `/devices` | Read-mostly hardware/registration inventory (suspend/delete act on existing enrolled hardware), not a "desired shape" to declare and reconcile. |
| YubiKey Hardware Tokens | `/org/factors/yubikey_token` | Consumable hardware-token seed inventory (write-once OTP seeds), not idempotent config. |
| Realms | `/realms` (Okta Identity Engine) | Multi-realm org partitioning is a preview/enterprise-tier feature not GA across all orgs; a single SSWS token's admin scope does not cleanly cross realms. |
| Identity Governance (Access Certifications/Requests, Entitlements) | Okta Identity Governance API | A distinct product and OpenAPI surface (`governance-*` specs) from the core Management API this app targets — out of scope for this app, not a gap in it. |
| Org privacy/support actions | `/org/privacy/*`, `/org/email/bounces/remove-list` | One-off consent/support actions (grant Okta support access, opt in/out of communications, clear a bounce list), not declarative state — there is nothing meaningful to "diff" against a desired value. |
| User-level factor/session actions | `/users/{id}/factors`, `/users/{id}/sessions` | Per-user lifecycle actions (enroll/reset a factor, clear a session), not org-level config — out of scope for the same reason the Users config type never manages general workforce lifecycle beyond activate/deactivate. |

Verified via the official `okta/okta-management-openapi-spec` GitHub repository (the source Okta
generates <https://developer.okta.com/docs/api/openapi/okta-management/> from) as of 2026-08-05.

## Health check

Handlers probe `GET /org` — a single-object read that proves the token is valid and has admin access
before doing any work.

## References

- API reference: <https://developer.okta.com/docs/reference/>
- Policies concepts: <https://developer.okta.com/docs/concepts/policies/>
