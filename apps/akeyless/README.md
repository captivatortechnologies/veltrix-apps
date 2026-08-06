# Akeyless

Manage [Akeyless](https://www.akeyless.io/) (secrets management / secure remote access platform)
configuration as code through the **Akeyless REST API**. Author configurations in the platform's
Configuration Canvas and deploy them through the Security-as-Code pipeline — validate, deploy, health
check, drift detection and rollback are handled per configuration type.

## Transport

Akeyless exposes a plain **REST/JSON API over HTTPS** — every operation is a single `POST` with a JSON
body, no path parameters, hosted at `https://api.akeyless.io` (confirmed directly from the OpenAPI spec
published at [`akeylesslabs/technical-documentation`](https://github.com/akeylesslabs/technical-documentation)
— `host: api.akeyless.io`, `schemes: [https]`). This app talks to it with plain in-process `fetch()` —
no subprocess, no compiled binary, no non-SDK runtime dependency.

## Credentials

The app authenticates as an **Akeyless API Key auth method**:

1. In the Akeyless Console, go to **Auth Methods → New → API Key** and create a dedicated auth method.
2. Associate it with a role (or the built-in Admin role) that covers what this app manages: Auth
   Methods, Roles, Targets, Dynamic Secrets, Rotated Secrets, Event Forwarders, Gateway configuration.
3. Copy its **Access ID** and **Access Key** — the key is shown once, at creation time.

Store them as a Veltrix credential:

| Veltrix credential field | Akeyless value |
| --- | --- |
| Username | API Key auth method's **Access ID** |
| API token | API Key auth method's **Access Key** |

Register an **`akeyless-account`** component whose hostname is `api.akeyless.io` (the public SaaS
control plane) or a private Akeyless Gateway's URL, and attach the credential.

On every request the app exchanges the Access ID/Key for a token via `POST /auth` (operation `auth`) —
`{"access-id", "access-key", "access-type": "access_key"}` → `{token, expiration, creds}` — then sends
that token as a `token` field **inside every subsequent request's JSON body** (Akeyless does not use an
`Authorization` header). Error responses are a single `{"error": "<message>"}` envelope (`JSONError`).

## What it manages

| Configuration type | Akeyless object(s) | API |
| --- | --- | --- |
| Auth Methods | API Key, AWS IAM, Azure AD, Kubernetes, OIDC auth methods | `/auth-method-create-{type}`, `/auth-method-update-{type}`, `/auth-method-get`, `/auth-method-delete` |
| Roles | Dashboard access levels, path-based rules, auth-method associations | `/create-role`, `/update-role`, `/get-role`, `/set-role-rule`, `/delete-role-rule`, `/assoc-role-am`, `/update-assoc`, `/delete-assoc` |
| Targets | Database, AWS, Kubernetes connection profiles | `/target-create-{type}`, `/target-update-{type}`, `/target-get-details`, `/target-delete` |
| Dynamic Secret Configs | PostgreSQL, AWS, Kubernetes producer definitions | `/dynamic-secret-create-{type}`, `/dynamic-secret-update-{type}`, `/dynamic-secret-get`, `/dynamic-secret-delete` |
| Rotated Secret Configs | PostgreSQL, AWS rotator definitions | `/rotated-secret-create-{type}`, `/rotated-secret-update-{type}`, `/rotated-secret-list`, `/rotated-secret-delete` |
| Event Forwarders | Slack, Email, Webhook, Microsoft Teams, ServiceNow | `/event-forwarder-create-{type}`, `/event-forwarder-update-{type}`, `/event-forwarder-get`, `/event-forwarder-delete` |
| Kubernetes Gateway Auth Config | Gateway-side K8s auth validation | `/gateway-create-k8s-auth-config`, `/gateway-update-k8s-auth-config`, `/gateway-get-k8s-auth-config`, `/gateway-delete-k8s-auth-config` |
| Gateway Allowed Access | Auth-method → Gateway-admin permission bindings | `/gateway-create-allowed-access`, `/gateway-update-allowed-access`, `/gateway-get-allowed-access`, `/gateway-delete-allowed-access` |

Every endpoint above, its exact request/response field names, and every write-only field was verified
directly against the [Akeyless OpenAPI spec](https://github.com/akeylesslabs/technical-documentation)
and cross-checked against the actively-maintained
[`akeyless-community/terraform-provider-akeyless`](https://github.com/akeyless-community/terraform-provider-akeyless)
source (which exercises the same endpoints through the official `akeyless-go` SDK) — not assumed from
API parity with other secrets platforms.

### Secret values are never managed here

The declarative **configuration** for a secret producer/rotator is genuinely different from the
**value** it produces, and this app only ever manages the former:

- **Static, dynamic and rotated secret VALUES** — fetched via `/dynamic-secret-get-value`,
  `/get-dynamic-secret-value`, `/rotated-secret-get-value`, `/get-rotated-secret-value`, or a static
  item's own value — are **never read, written or diffed**.
- Every embedded **credential** a config type needs to reach its target (Database/Target passwords, AWS
  Secret Access Keys, Kubernetes cluster tokens/CA certs, OIDC client secrets, webhook URLs and
  auth secrets) is **write-only**: sent on create/update, never read back, diffed, or logged. This
  matches every Terraform schema field Akeyless itself marks `Sensitive: true` — this app applies that
  same boundary even where the API technically echoes a field back on `GET` (e.g. some Target detail
  responses), rather than trusting that echo.
- **Auth-method credentials are generated by Akeyless, not authored here**: an API Key auth method's
  Access ID/Key are returned once at creation and never sent or read by this app.

### Type-selector config types

Auth Methods, Targets, Dynamic Secret Configs, Rotated Secret Configs and Event Forwarders each cover
**multiple Akeyless object types behind one config type**, using a `type` field that is **immutable**
once an item is created — Akeyless exposes a dedicated create/update/get endpoint *per type*
(`/target-create-db` vs `/target-create-aws` vs `/target-create-k8s`, etc.), so this app refuses to
convert one type into another in place; it fails the deploy with a clear message instead of silently
deleting and recreating the object (which would rotate IDs and break every dependent reference).

### API asymmetries this app had to account for

Several real, verified quirks in the Akeyless API shaped the implementation:

- **Roles**: `update-role` uses `event-forwarder-access` (singular) where `create-role` uses
  `event-forwarders-access` (plural), and `event-forwarders-name` is create-only — updates to which
  named forwarders a role manages are instead reconciled through `/set-role-rule` /
  `/delete-role-rule` with `rule-type: event-forwarder-rule` (Akeyless overloads this rule type for
  both the account-wide access level and per-forwarder-name scoping).
- **Roles**: dashboard access levels (`audit-access`, `analytics-access`, ...) have no flat field on
  `GET /get-role` — each is encoded as a special `PathRule` (`search-rule`, `reports-rule`, ...,
  `capability: [read]`, `path: /*`|`/self`|`/scoped`). `lib/` mirrors the terraform provider's own
  decode of this (`extractAccessLevels` in `config-types/roles/deploy.ts`).
- **Roles**: `sub-claims` is `{key: "v1,v2"}` (a single comma-joined string per key) on
  `/assoc-role-am` / `/update-assoc`, but `{key: ["v1","v2"]}` (an array) on `GET /get-role`. The same
  asymmetry applies to Gateway Allowed Access's `sub-claims` and `permissions` fields.
- **Dynamic Secrets (AWS)**: `aws-user-policies` / `aws-user-groups` / `aws-role-arns` are
  comma-joined strings on the wire, not JSON arrays, despite modeling naturally as a tags field in the
  canvas.
- **Auth methods**: two endpoint families exist for the same operations
  (`/auth-method-create-aws-iam` vs `/create-auth-method-aws-iam`); this app uses the
  `/auth-method-create-*` / `/auth-method-update-*` / `/auth-method-get` / `/auth-method-list` /
  `/auth-method-delete` family, matching what the terraform provider's own Go SDK calls exercise.
- **Kubernetes Gateway Auth Config**: unlike every other secret in this app, `signing-key` is
  **required on every `create` AND `update` call** (confirmed directly in the OpenAPI spec) — there is
  no "leave blank to keep unchanged" here. Rollback of an update to a pre-existing config is therefore
  not possible (this app never has a prior value to resend) and is surfaced clearly rather than
  attempted.
- **Event Forwarders**: no list endpoint exists for this object type at all — existence is always
  checked by `GET`-by-name. Roles' "Scoped Event Forwarders" field is a plain tags field for the same
  reason. Microsoft Teams additionally requires its Webhook URL and Gateway Event Sources on every
  call (not just create), with the field name itself singular (`gateway-event-source-locations`)
  where every other type uses the plural `gateways-event-source-locations`.
- **Rotated Secrets**: there is **no "get rotated-secret configuration" endpoint** — only
  `/rotated-secret-list` (id/name/type/active, never the rotation settings) and
  `/rotated-secret-get-value` (the rotated credential VALUE, out of scope). Drift detection for this
  config type is therefore existence + active-state only, and rollback of an update to a pre-existing
  rotator cannot restore its prior settings — both limitations are documented in-code
  (`rotated-secret-configs/canvas.yaml`, `driftDetect.ts`, `rollback.ts`) rather than faked.

### Roles: rules vs. associations

Akeyless's `rules` (path-based access) and `authMethodAssociations` (role↔auth-method bindings) use
**different reconciliation strategies**, because the underlying API supports different operations for
each:

- **Rules are additive-only.** `/set-role-rule` has no bulk-replace counterpart, and Akeyless roles can
  carry admin-created "restricted" rules (e.g. deny rules) this app must never silently remove. Every
  rule declared in the canvas is created/updated on deploy; a rule **removed** from the canvas is
  **not** deleted from Akeyless. Delete it directly in Akeyless if it's no longer needed.
- **Associations are a full replace.** `GetRole` returns the role's complete, current association
  list, so this app safely diffs declared vs. live and adds/updates/removes to match exactly what's
  declared — an association **not** listed in the canvas **is** removed on deploy.

## Coverage

This first release targets **8 high-value, genuinely declarative and round-trippable** configuration
types, chosen after directly verifying every candidate endpoint against the Akeyless OpenAPI spec and
the `akeyless-community/terraform-provider-akeyless` source, rather than assuming API parity with other
secrets-management platforms.

- **Auth Methods** (`/auth-method-create-api-key|aws-iam|azure-ad|k8s|oidc`) — the 5 clearest,
  most commonly deployed auth-method types out of Akeyless's ~14 (also: cert, email, GCP, Huawei,
  Kerberos, LDAP, OAuth2, OCI, SAML, Universal Identity — deferred; each would need its own
  type-specific field set researched to the same depth).
- **Roles** (`/create-role` + `/set-role-rule` + `/assoc-role-am`) — dashboard access levels, rules
  (additive) and auth-method associations (full replace); see the asymmetries above.
- **Targets** (`/target-create-db|aws|k8s`) — 3 of ~35 target types (Database, AWS, Kubernetes),
  covering the universal credentials-based DB connection type. Not modeled: Azure/GCP/EKS/GKE cloud
  targets; SSH/LDAP/Web/GitHub/GitLab/Docker Hub/Artifactory/RabbitMQ/Salesforce/Okta/Ping/Keycloak
  targets; PKI-issuer targets (DigiCert/Sectigo/GlobalSign/Let's Encrypt/ZeroSSL/Google Trust); AI
  provider targets (OpenAI/Anthropic/Bedrock/Gemini/Grok); HashiCorp Vault/Cloudflare/Windows/Linked
  targets. Also not modeled within Database targets: `cloud-identity`/`wallet`/`parent-target`
  connection types, and provider-specific fields for Snowflake/Oracle/MongoDB Atlas.
- **Dynamic Secret Configs** (`/dynamic-secret-create-postgresql|aws|k8s`) — 3 of ~24 producer types
  (PostgreSQL, AWS, Kubernetes). Not modeled: MySQL/MSSQL/MongoDB/HanaDB/Oracle/Cassandra/Redshift
  database producers; Azure/GCP/EKS/GKE cloud producers; GitHub/GitLab/Docker Hub/Artifactory/
  Google Workspace/LDAP/OpenAI/Ping/RabbitMQ/RDP/Redis/Venafi producers; the Kubernetes producer's
  "dynamic" Service Account mode (auto-provisioning a fresh Service Account + RoleBinding per
  credential — only the "fixed" pre-existing Service Account mode is modeled); password-rule
  definitions (`input_rule`/`output_rule`) and most Secure Remote Access sub-settings beyond a basic
  enable toggle.
- **Rotated Secret Configs** (`/rotated-secret-create-postgresql|aws`) — 2 of ~19 rotator types.
  Field-level drift detection is not possible for this config type (see asymmetries above). Not
  modeled: MySQL/MSSQL/MongoDB/HanaDB/Oracle/Cassandra/Redis/Redshift/Splunk/Windows/SSH/LDAP/
  Azure/GCP/Docker Hub/OpenAI rotators.
- **Event Forwarders** (`/event-forwarder-create-slack|email|webhook|teams|servicenow`) — **full
  coverage**, all 5 of Akeyless's event-forwarder types.
- **Kubernetes Gateway Auth Config** (`/gateway-create-k8s-auth-config`) — full coverage of the
  documented fields; Signing Key is required and write-only on every deploy (see asymmetries above).
- **Gateway Allowed Access** (`/gateway-create-allowed-access`) — full coverage.

### Intentionally excluded (this release)

| Surface | API | Why excluded |
| --- | --- | --- |
| Static/dynamic/rotated secret VALUES | `/dynamic-secret-get-value`, `/get-dynamic-secret-value`, `/rotated-secret-get-value`, `/get-rotated-secret-value`, static item values | Secret material by definition — the entire point of this app's scope boundary (per its brief) is to manage HOW secrets are produced/rotated/accessed, never the secret bytes themselves. |
| Auth-method credentials (Access ID/Key, OIDC client secret) | embedded in Auth Method create/update | Generated by Akeyless (API Key) or write-only (OIDC secret) - never read back by this app, matching the treatment of secrets in every other Veltrix secrets/IAM app. |
| One-shot gateway/rotation actions | `/gateway-rotate-secret`, `/gateway-migration-*`, one-shot rotate-now commands | Imperative actions, not declarative configuration - out of scope for the same reason every sibling Veltrix app excludes one-shot operations. |
| Read-only audit/analytics | `/list-*` audit trails, usage reports, analytics endpoints | Read-only observability data, not org-level declarative config. |
| Items (static secrets, certificates, classic keys, DFC/HSM keys) | `/create-secret`, `/create-certificate`, `/create-classic-key`, `/create-dfc-key`, ... | The general Akeyless "Item" catalog holds secret material and cryptographic key material directly - out of scope by the same secret-value boundary above. |
| PKI/SSH Certificate Issuers | `/pki-cert-issuer-*`, `/ssh-cert-issuer-*` | Certificate issuance policy is a plausible future config type, but was not researched to the same depth as this release's 8 types - deferred rather than guessed at. |
| Folders, Tags, Groups, MCP secrets, OIDC apps, Passkeys | various | Organizational/metadata objects and newer product surfaces not yet researched to this app's verification bar - deferred for a future pass. |
| Gateway migration wizards, log-forwarding destinations, remote-access session logging | `/gateway-migration-*`, `/gateway-update-log-forwarding-*`, `/gw-remote-access-session-logs-*` | Genuinely large surfaces (10+ log/SIEM destinations, 7+ migration source types) that deserve their own dedicated research pass rather than a shallow pass here. |

Verified directly against the [Akeyless OpenAPI spec](https://github.com/akeylesslabs/technical-documentation)
and the [`akeyless-community/terraform-provider-akeyless`](https://github.com/akeyless-community/terraform-provider-akeyless)
source as of 2026-08.

## Health check

Handlers probe a lightweight, low-privilege call before doing any per-configuration-type work — most
config types use their own `GET`-by-name or a cheap `list` endpoint; Event Forwarders and Gateway
config types (which have no list endpoint) probe `/list-auth-methods` instead, then verify each
declared item individually by name.

## References

- Akeyless API OpenAPI spec: <https://github.com/akeylesslabs/technical-documentation> (`reference/akeyless-api.json`)
- Akeyless API docs: <https://docs.akeyless.io/reference>
- Terraform provider (ground truth for exact field/endpoint behavior): <https://github.com/akeyless-community/terraform-provider-akeyless>
- Auth: <https://docs.akeyless.io/reference/auth>
- Roles: <https://docs.akeyless.io/reference/createrole>
- Auth Methods: <https://docs.akeyless.io/reference/createauthmethod>
