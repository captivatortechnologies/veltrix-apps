# Changelog

All notable changes to the Akeyless app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Akeyless config-as-code app, built research-first directly against the
[Akeyless OpenAPI spec](https://github.com/akeylesslabs/technical-documentation) and cross-checked
against the actively-maintained
[`akeyless-community/terraform-provider-akeyless`](https://github.com/akeyless-community/terraform-provider-akeyless)
source (every endpoint, request/response field name and write-only boundary cited below was verified
against ground truth, not assumed from other secrets-management platforms).

Eight configuration types, covering the core declarative surface of the Akeyless REST API:

- **Auth Methods** (`config-types/auth-methods`) — API Key, AWS IAM, Azure AD, Kubernetes and OIDC
  auth methods via `/auth-method-create-{type}` / `/auth-method-update-{type}` (type immutable;
  credentials write-only).
- **Roles** (`config-types/roles`) — dashboard access levels, path-based rules (additive-only via
  `/set-role-rule`) and auth-method associations (full replace via `/assoc-role-am`/`/update-assoc`/
  `/delete-assoc`) via `/create-role` + `/update-role`.
- **Targets** (`config-types/targets`) — Database, AWS and Kubernetes connection profiles via
  `/target-create-{type}` / `/target-update-{type}` (type immutable; embedded credentials write-only).
- **Dynamic Secret Configs** (`config-types/dynamic-secret-configs`) — PostgreSQL, AWS and Kubernetes
  producer definitions via `/dynamic-secret-create-{type}` / `/dynamic-secret-update-{type}` — never
  the produced credential values.
- **Rotated Secret Configs** (`config-types/rotated-secret-configs`) — PostgreSQL and AWS rotator
  definitions via `/rotated-secret-create-{type}` / `/rotated-secret-update-{type}` — never the
  rotated credential values; drift detection is existence-only (Akeyless has no "get rotator config"
  endpoint, see README).
- **Event Forwarders** (`config-types/event-forwarders`) — full coverage of all 5 forwarder types
  (Slack, Email, Webhook, Microsoft Teams, ServiceNow) via `/event-forwarder-create-{type}` /
  `/event-forwarder-update-{type}` — webhook URLs and credential secrets are write-only.
- **Kubernetes Gateway Auth Config** (`config-types/k8s-auth-config`) — Gateway-side K8s auth
  validation via `/gateway-create-k8s-auth-config` / `/gateway-update-k8s-auth-config` — Signing Key
  is required (and write-only) on every deploy, a real API asymmetry documented in-code.
- **Gateway Allowed Access** (`config-types/gateway-allowed-access`) — full coverage of auth-method to
  Gateway-admin permission bindings via `/gateway-create-allowed-access` /
  `/gateway-update-allowed-access`.

Authentication is an Akeyless **API Key auth method** (`POST /auth` with `access-id`/`access-key` →
short-lived `token`, sent as a `token` field inside every subsequent request body — Akeyless does not
use an `Authorization` header), with the connection's endpoint defaulting to the public
`api.akeyless.io` SaaS control plane or an operator's private Gateway URL.

Several real API asymmetries were discovered and handled explicitly rather than papered over: `roles`'
`update-role` uses different field names than `create-role` (including a create-only field reconciled
instead via `set-role-rule`'s overloaded `event-forwarder-rule` type); `sub-claims`/`permissions` are
comma-joined strings on write but arrays on read across Roles and Gateway Allowed Access; AWS dynamic
secrets' policy/group/role-ARN lists are comma-joined strings, not JSON arrays; two duplicate endpoint
families exist for auth-method CRUD; Kubernetes Gateway Auth Config's Signing Key has no "leave blank to
keep unchanged" semantics; and Rotated Secrets have no read endpoint for their own configuration at all.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
confirmed non-declarative or deferred surfaces (secret VALUES are always excluded by design; most of
Akeyless's ~35 target types, ~24 dynamic-secret types and ~19 rotator types are deferred to a future
pass; gateway migration wizards and log-forwarding destinations are large surfaces left for dedicated
future research).
