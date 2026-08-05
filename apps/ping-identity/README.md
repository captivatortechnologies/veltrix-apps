# Ping Identity (PingOne)

Manage [PingOne](https://www.pingidentity.com/en/platform/capabilities/authentication-authority.html)
(Ping Identity's cloud IAM platform) configuration as code through the **PingOne Platform API**.
Author configurations in the platform's Configuration Canvas and deploy them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback are handled
per configuration type.

## Credentials

The app authenticates as a **PingOne worker application** using the OAuth2 `client_credentials`
grant:

1. In the PingOne admin console, go to **Applications → Applications → + Add Application → Worker**.
2. Grant the worker application a role scoped to what this app manages (e.g. **Environment Admin**, or
   a narrower custom admin role covering sign-on policies, password policies, populations, groups,
   applications, resources, identity providers, MFA policies and risk policies).
3. Copy its **Client ID** and **Client Secret** (the secret is shown once).

Store them as a Veltrix credential:

| Veltrix credential field | PingOne value |
| --- | --- |
| Username | Worker application **Client ID** |
| API token | Worker application **Client Secret** |

Register a **`pingone-environment`** component whose hostname is your PingOne **Environment ID**
(Environments → your environment → **Properties**), attach the credential, and set the app's
**PingOne Region** setting to match your environment's data-residency region (North America / EU /
Canada / Asia-Pacific / Australia / Singapore) — the region is fixed at environment creation and
cannot be derived from the environment id alone.

On every request the app exchanges the worker credentials for a short-lived access token via
`POST https://auth.pingone.<region>/{environmentId}/as/token` (HTTP Basic client_credentials grant),
then calls `https://api.pingone.<region>/v1/environments/{environmentId}/...` with
`Authorization: Bearer <token>`. Both the region-to-hostname-suffix mapping and the token-endpoint
construction were verified directly against Ping's own generated SDK source
(`patrickcping/pingone-go-sdk-v2`) — the same OpenAPI specification that backs
<https://apidocs.pingidentity.com/pingone/platform/v1/api/>.

## What it manages

| Configuration type | PingOne object(s) | API |
| --- | --- | --- |
| Sign-On Policies | Sign-on policies + their ordered sign-on actions (login/identifier-first/MFA/IdP/agreement/progressive-profiling) | `/signOnPolicies`, `.../actions` |
| Password Policies | Password complexity, history, age, lockout | `/passwordPolicies` |
| MFA Device Policies | Per-authenticator (SMS/Voice/Email/TOTP/Mobile/FIDO2) enablement + OTP settings | `/deviceAuthenticationPolicies` |
| Populations | User populations + assigned password policy + default identity provider | `/populations`, `.../defaultIdentityProvider` |
| Groups | Static or SCIM-filter dynamic groups, optionally scoped to a population | `/groups` |
| Applications | OIDC and SAML application configurations | `/applications` |
| Resources & Scopes | Custom API resources + their OAuth scopes | `/resources`, `.../scopes` |
| Identity Providers | External IdPs — OIDC, SAML, and social (Google/Microsoft/Facebook/GitHub/LinkedIn/Amazon/Apple/PayPal/Twitter/Yahoo) | `/identityProviders` |
| Risk Policies | PingOne Protect risk policy sets — evaluated predictors + ordered override/mitigation rules | `/riskPolicySets` |

Several deeply-nested pieces (sign-on-policy `condition` trees, resource/risk-policy rule arrays) are
authored as a single JSON field rather than fully decomposed canvas controls — the same convention
`okta-identity` uses for its policy rules — because their shape varies enormously by type and PingOne's
own documentation expresses them as recursive trees. Every JSON field's exact wire shape (with
examples) is documented in that field's help text in `canvas.yaml`.

## Coverage

This first release targets the **9 highest-value, genuinely declarative and round-trippable**
surfaces of the PingOne Platform API — the core IAM configuration a security/identity team would
author as code: authentication flow (sign-on policies + actions), credential policy (password
policies, MFA device policies), directory (populations, groups), application onboarding
(applications, resources & scopes), federation (identity providers), and PingOne Protect (risk
policies).

### Intentionally excluded (this release)

| Surface | API | Why excluded |
| --- | --- | --- |
| Worker applications | `/applications` (`type: WORKER`) | This app's own connection IS a worker application's credentials — managing worker apps here would be self-referential and risks locking out the connection itself. |
| Application / resource client secrets | `/applications/{id}/secret`, `/resources/{id}/secret` | Server-generated and returned by a dedicated, separate endpoint — secret material is treated as write-only/out-of-scope everywhere in this app, matching the treatment of IdP and resource secrets. |
| Notification templates & settings | `/templates`, `/notificationsSettings`, `/notificationsPolicies` | A real, declarative surface (customize email/SMS/push content and delivery), but a large per-template x per-locale content-authoring surface — deferred to a dedicated future pass rather than bolted on here, the same call `okta-identity` made for its brand email-template customizations. |
| Agreements (Terms of Service / consent) | `/agreements`, `.../languages`, `.../revisions` | Genuinely declarative, but multi-language legal-text authoring with a revision history is a distinct content-authoring surface — deferred to a future pass. Sign-on policies can still reference an existing agreement by id in an AGREEMENT action. |
| Branding (themes / branding settings) | `/themes`, `/brandingSettings` | Visual/marketing configuration, not a security-relevant config-as-code surface — the same reasoning `okta-identity` applied to Org Settings. |
| Certificate / key management | `/keys`, `/keyRotationPolicies` | Managing cryptographic key material as "config" is a materially different trust model than everything else in this app (SAML/OIDC signing keys are referenced BY ID from applications/identity-providers, not authored here) — this app treats certificate ids as external references, paste-in text fields. |
| FIDO2 Policies | `/fido2Policies` | A real declarative resource; MFA Device Policies reference an existing FIDO2 policy by id (or fall back to the environment default) rather than this app owning FIDO2 policy authoring — deferred to keep the initial MFA surface focused. |
| Risk Predictors (custom) | `/riskPredictors` | Mostly Ping-managed, licensed, built-in detection logic; Risk Policies reference existing predictors by id via a live picker, but authoring new CUSTOM predictors (a small, advanced subset of this endpoint) is deferred. |
| PingOne Authorize (API access policies) | `authorize.pingone.<region>` — a distinct product/OpenAPI surface (`authorize_application_role`, `authorize_api_service`, decision endpoints) | A separate licensed product with a materially larger and differently-shaped policy model (fine-grained authorization decisioning) than the core Platform API this app targets — out of scope for this app, not a gap in it, exactly the same reasoning `okta-identity` applies to Identity Governance. |
| Users, Sessions, Devices (per-user) | `/users`, `/users/{id}/sessions`, `/users/{id}/devices` | Per-user lifecycle/inventory, not org-level declarative config — out of scope for the same reason `okta-identity`'s Users type never manages general workforce lifecycle. |
| Gateways (LDAP/RADIUS) | `/gateways` | On-premises directory-bridging infrastructure with its own credential/connectivity model distinct from a pure REST config surface — a candidate for a future, dedicated connectivity-aware pass. |
| Environments themselves | `/environments` | This app manages configuration WITHIN a environment (the connection's target), not the environment resource itself (billing/licensing/region are fixed at creation and managed at the organization level). |

Verified against `patrickcping/pingone-go-sdk-v2` (the Go SDK Ping Identity generates from its own
OpenAPI specification — the same one backing
<https://apidocs.pingidentity.com/pingone/platform/v1/api/>) as of 2026-08.

## Health check

Handlers probe `GET /environments/{environmentId}` (via a worker access token) — a single-object read
that proves the worker credentials are valid, correctly scoped, and the environment id + region are
correct together — before doing any per-configuration-type work.

## References

- PingOne Platform API reference: <https://apidocs.pingidentity.com/pingone/platform/v1/api/>
- PingOne developer portal: <https://developer.pingidentity.com/pingone-api/>
- `patrickcping/pingone-go-sdk-v2` (source-of-truth for exact endpoint paths and JSON field names used to build this app): <https://github.com/patrickcping/pingone-go-sdk-v2>
