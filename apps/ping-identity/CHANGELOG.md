# Changelog

All notable changes to the Ping Identity app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Ping Identity (PingOne) config-as-code app, built research-first against
`patrickcping/pingone-go-sdk-v2` (the Go SDK Ping Identity generates from its own OpenAPI
specification — the same one backing
[apidocs.pingidentity.com/pingone/platform/v1/api](https://apidocs.pingidentity.com/pingone/platform/v1/api/)).

Nine configuration types, covering the core declarative surface of the PingOne Platform API:

- **Sign-On Policies** (`config-types/sign-on-policies`) — sign-on policies and their ordered
  sign-on actions (login, MFA, identifier-first, external IdP, agreement, progressive profiling) via
  `/signOnPolicies` and `.../actions`. Actions are reconciled by priority, never destructively pruned.
- **Password Policies** (`config-types/password-policies`) — length, complexity, history, age and
  lockout rules via `/passwordPolicies`.
- **MFA Device Policies** (`config-types/mfa-device-policies`) — per-authenticator (SMS/Voice/Email/
  TOTP/Mobile/FIDO2) enablement and OTP settings via `/deviceAuthenticationPolicies`.
- **Populations** (`config-types/populations`) — user populations, their assigned password policy,
  and default identity provider via `/populations` and `.../defaultIdentityProvider`.
- **Groups** (`config-types/groups`) — static or SCIM-filter dynamic groups, optionally scoped to a
  population, via `/groups`.
- **Applications** (`config-types/applications`) — OIDC and SAML application configurations via
  `/applications` (worker applications are protected and never touched — this app's own connection IS
  a worker application).
- **Resources & Scopes** (`config-types/resources`) — custom API resources and their OAuth scopes via
  `/resources` and `.../scopes` (the built-in `openid` and PingOne API resources are protected).
- **Identity Providers** (`config-types/identity-providers`) — external OIDC/SAML/social identity
  providers via `/identityProviders`; client secrets and signing keys are write-only.
- **Risk Policies** (`config-types/risk-policies`) — PingOne Protect risk policy sets (evaluated
  predictors + ordered override/mitigation rules) via `/riskPolicySets`.

Authentication is a PingOne **worker application** (OAuth2 `client_credentials` grant against
`auth.pingone.<region>/{environmentId}/as/token`), with the connection's Environment ID stored as the
`pingone-environment` component hostname and the data-residency region (NA/EU/CA/AP/AU/SG) as an app
setting — verified directly against the SDK's region-to-hostname-suffix mapping and token-endpoint
construction rather than assumed.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
deferred to a future pass (notification templates, agreements, branding, PingOne Authorize, FIDO2
policies, custom risk predictors, gateways).
