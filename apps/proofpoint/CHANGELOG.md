# Changelog

All notable changes to the Proofpoint Essentials app are documented here.

## 1.2.0 — 2026-08-04

Config-as-code write-surface exhaustion pass, re-audited against the live
Essentials Interface API OpenAPI document (fetched directly from a running
stack, `/apidocs/apidocs/docs`, linked from `/api/v1/docs/specification.php`).
See the README's [Coverage](README.md#coverage-v120) section for the full
audit, including what was intentionally left out and why (Users, DKIM private
keys, Azure AD sync secrets, Package/Licensing billing actions, and every
other Proofpoint product — TAP, TRAP/Threat Response, the Protection Server,
NPRE, Isolation, PSAT, CASB, ITM, ET Intelligence — which are separate
products with their own consoles/auth outside this app's Essentials scope).

### Fixed

- **`pp-sender-lists` (organization scope) was writing the wrong resource.**
  The prior implementation reconciled the organization scope with a
  read-modify-write `PUT /orgs/{org}` using field names `allow_list`/
  `block_list`. The live API's `Organization` resource actually names those
  fields `safe_list_senders`/`block_list_senders`, and `/orgs/{org}` no longer
  documents a `PUT` method at all (only `GET`/`DELETE`/`PATCH`) —
  `allow_list`/`block_list` belong to the dedicated `/orgs/{org}/sender-lists`
  resource, which is what deploy/rollback/driftDetect/healthCheck now use.

### Added

- **`pp-sender-lists`** extended from organization-only to also cover **user**
  and **group** scoped Safe/Blocked sender overrides, via the same
  sender-lists resource addressed at `/orgs/{org}/users/{email}/sender-lists`
  and `/orgs/{org}/groups/{id}/sender-lists`. A new "Scope" field group
  (`scope`: org/user/group, `scope_id`) selects the target; reconciliation
  identity is now the (scope, scope_id, sender) tuple. Rollback now PATCHes
  the exact prior list array back per scope instead of computing a removal
  set, eliminating any dependency on the vendor API's undocumented `DELETE`
  request-body shape for this resource.
- **Proofpoint Authentication Settings** (`pp-authentication-settings`) —
  manage the organization-wide MFA policy (`is_mfa_enabled`,
  `mfa_admins_only`) and Login/SSO policy (`allow_local_login`,
  `allow_azure_login`, `force_azure_login`, `idp_for_forced_login`) via
  `/orgs/{org}/authentication/settings/{mfa,login}`. Organization-wide
  singleton; validation rejects a configuration that would disable every
  login method (local + Azure + no forced SSO IDP), which would lock the
  organization out.
- **Proofpoint Identity Providers** (`pp-identity-providers`) — full SAML SSO
  Identity Provider CRUD via `/orgs/{org}/authentication/settings/idps`.
  Reconciled by IDP name (upsert: PUT an existing IDP by its server-assigned
  UUID, POST a new one). Every managed field is public SAML metadata (entity
  id, login/logout URLs, the IDP's own verification certificate) — no secret
  is ever sent or stored by this config type.
- **Proofpoint Email Tagging** (`pp-email-tagging`) — the granular Email
  Warning Tag settings (DMARC-failure/domain-age/geo-IP conditions, the
  "Learn more" action, a custom banner) and Email Subject Tag settings (a
  subject-line prefix) via `/orgs/{org}/email-tagging`. Organization-wide
  singleton, more detailed than the on/off `email_warning_tags` toggle
  `pp-org-features` already manages (which remains a simple master switch).
- **Proofpoint Email Tagging Exemptions** (`pp-email-tagging-exemptions`) —
  the sender allow-list that Email Tagging never tags, via
  `/orgs/{org}/email-tagging/exemptions`. Reconciled additively by sender
  value, same shape as `pp-sender-lists`.

## 1.1.0 — 2026-07-26

### Added

- **Proofpoint Organization Features** (`pp-org-features`) configuration type —
  manage the organization's security/protection features as code through the
  Essentials Interface API features resource (`GET`/`PUT /orgs/{org}/features`).
  Covers the documented boolean features: **URL Defense** (`url_defense`),
  **Attachment Defense** (`attachment_defense`) and its **sandboxing**
  (`attachment_defense_sandboxing`), **Anti-Spoofing** (`anti_spoofing`),
  **DLP** (`dlp`), **Email Encryption** (`email_encryption`), **Email Warning
  Tags** (`email_warning_tags`), **Email Archive** (`email_archive`),
  **Disclaimers** (`disclaimers`), **Social Media Account Protection**
  (`social_media_account_protection`), **Outbound Relaying**
  (`outbound_relaying`), **SMTP Discovery** (`smtp_discovery`), **One-Click
  Remediation** (`one_click_remediation`) and **Automatic Remediation**
  (`automatic_remediation`). Reconciled by feature name with a read-modify-write
  `PUT` (features it did not declare are preserved), full drift detection, health
  check and rollback to the captured prior values.

### Notes

- Feature availability depends on the organization's Essentials licensing
  package; enabling a feature the package does not include is rejected by
  Proofpoint with `HTTP 403`, which the deploy surfaces verbatim.
- `instant_replay` is intentionally excluded: the Interface API documents it as
  the one non-boolean feature, so it cannot be reconciled with a simple on/off
  toggle.
