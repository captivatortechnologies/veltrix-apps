# Changelog

All notable changes to the OneLogin app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the OneLogin config-as-code app, built research-first directly against
[developers.onelogin.com](https://developers.onelogin.com/) (every endpoint and write-shape cited
below was fetched and verified, not assumed from other IAM platforms).

Six configuration types, covering the core declarative surface of the OneLogin API:

- **Apps** (`config-types/apps`) — SSO application connectors (SAML/OIDC/catalog), visibility,
  admin-impersonation toggle, provisioning enablement, and connector-specific `configuration`/
  `parameters` via `/api/2/apps` (partial-update PUT, confirmed from OneLogin's own docs).
- **Roles** (`config-types/roles`) — roles and their full assigned-Apps set via `/api/2/roles` +
  `PUT .../apps` (a confirmed full-replace endpoint).
- **User Mappings** (`config-types/mappings`) — account-wide, ordered condition→action rules via
  `/api/2/mappings` + `PUT .../sort`, reconciled non-destructively against undeclared mappings (see
  README's Ordered reconciliation section).
- **App Rules** (`config-types/app-rules`) — the same ordered-rule model as User Mappings, scoped per
  application via `/api/2/apps/{id}/rules` + `.../rules/sort`.
- **Privileges** (`config-types/privileges`) — custom Delegated Administration policy documents
  (`Version`/`Statement`) and diff-reconciled role/user assignment via `/api/1/privileges` (OneLogin
  never migrated this resource to v2).
- **Account Brands** (`config-types/brands`) — login-screen label/colors/instructions/messages via the
  Early Preview `/api/2/branding/brands` API; the account's `master` brand is never created or deleted.

Authentication is a OneLogin **API Credential** (OAuth2 `client_credentials` grant against
`/auth/oauth2/v2/token`), with the connection's subdomain stored as the `onelogin-account` component
hostname — OneLogin has no separate regional API host to configure, unlike Okta/PingOne.

Two config types (User Mappings, App Rules) required solving OneLogin's all-or-nothing Bulk Sort
contract (`PUT .../sort` 422s unless every id for the scope is present) — implemented as a generic,
independently-tested `reconcileOrder` helper in `lib/oneLogin.ts` that re-inserts only the
canvas-declared ids, in their declared order, without disturbing ids this app doesn't manage.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
confirmed non-declarative (Groups is read-only; custom attribute *field definitions* have no
create/update API; Smart Hooks require resending a write-only code body on every call; MFA is
per-user-only) or deferred (Risk Rules/Vigilance AI have no confirmed public config endpoint;
Self-Registration's doc pages 404'd during this research pass).
