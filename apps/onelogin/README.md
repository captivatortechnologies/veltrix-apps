# OneLogin

Manage [OneLogin](https://www.onelogin.com/) (One Identity's cloud IAM platform) configuration as
code through the **OneLogin API**. Author configurations in the platform's Configuration Canvas and
deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift detection
and rollback are handled per configuration type.

## Credentials

The app authenticates as a **OneLogin API Credential** using the OAuth2 `client_credentials` grant:

1. In the OneLogin admin console, go to **Developers → API Credentials → New Credential**.
2. Grant it the **Manage All** scope (or a narrower scope covering what this app manages: Apps, Roles,
   Mappings, App Rules, Privileges, Brands).
3. Copy its **Client ID** and **Client Secret** (the secret is shown once).

Store them as a Veltrix credential:

| Veltrix credential field | OneLogin value |
| --- | --- |
| Username | API Credential **Client ID** |
| API token | API Credential **Client Secret** |

Register an **`onelogin-account`** component whose hostname is your OneLogin **subdomain** (e.g.
`acme` or `acme.onelogin.com` — the same address you use to log in) and attach the credential. Unlike
Okta/PingOne, OneLogin has **no separate regional/data-center API host to select** — the subdomain
alone identifies the account and its data residency
([`/api-docs/2/getting-started/dev-overview`](https://developers.onelogin.com/api-docs/2/getting-started/dev-overview)).

On every request the app exchanges the API credential for an access token via
`POST https://<domain>/auth/oauth2/v2/token` (HTTP Basic `client_credentials` grant — see
[`/api-docs/2/oauth20-tokens/generate-tokens-2`](https://developers.onelogin.com/api-docs/2/oauth20-tokens/generate-tokens-2)),
then calls `https://<domain>/api/2/...` (or `/api/1/...` for the legacy Privileges endpoints — OneLogin
never migrated these to v2) with `Authorization: bearer <token>`.

## What it manages

| Configuration type | OneLogin object(s) | API |
| --- | --- | --- |
| Apps | SSO application connectors (SAML/OIDC/catalog), visibility, provisioning toggle, connector-specific configuration and provisioning parameters | `/api/2/apps` |
| Roles | Roles and their full assigned-Apps set | `/api/2/roles`, `.../apps` (full replace) |
| User Mappings | Account-wide, ordered condition→action rules run against every user | `/api/2/mappings`, `.../sort` |
| App Rules | Per-application, ordered condition→action provisioning rules | `/api/2/apps/{id}/rules`, `.../sort` |
| Privileges | Custom Delegated Administration policy documents + assigned roles/users | `/api/1/privileges`, `.../roles`, `.../users` |
| Account Brands | Login-screen label/colors/instructions/messages (Early Preview) | `/api/2/branding/brands` |

Deeply-nested pieces that vary by connector/condition/action (an App's `configuration`/`parameters`, a
Mapping/App Rule's `conditions`/`actions`, a Privilege's policy `Statement`) are authored as JSON
fields rather than fully decomposed canvas controls — the same convention `ping-identity` uses for its
sign-on-policy actions — because OneLogin's own wire format for these varies enormously and is best
authored verbatim. Every JSON field's exact shape (with examples) is documented in that field's help
text in `canvas.yaml`.

### Ordered reconciliation (User Mappings / App Rules)

Both User Mappings and App Rules run in ascending `position` order, and OneLogin's own Bulk Sort
endpoints (`PUT /api/2/mappings/sort`, `PUT /api/2/apps/{id}/rules/sort`) require the **complete**
id list on every call — a partial list returns a 422 ("Sorting list must contain all mapping IDs" /
"...must contain all mapping IDs" for app rules too, per OneLogin's own error text). Since a canvas may
declare only *some* of the account's mappings/rules, this app reconciles order **non-destructively**
(`lib/oneLogin.ts` → `reconcileOrder`): every id **not** declared in the canvas keeps its current
relative position, and the ids the canvas **does** declare are (re)inserted, in exactly the order
authored, at the position of the first one that already existed (or appended at the end when every
declared item is brand new). App Rules apply this per target app (each app's rule list sorts
independently); User Mappings apply it once, account-wide.

## Coverage

This first release targets **6 high-value, genuinely declarative and round-trippable** surfaces of the
OneLogin API — chosen after directly verifying each candidate endpoint against
[developers.onelogin.com](https://developers.onelogin.com/) rather than assuming API parity with other
IAM platforms (several plausible candidates turned out **not** to be declarative — see below).

- **Apps** (`/api/2/apps`) — full CRUD confirmed via `list-apps`, `get-app`, `create-app`,
  `update-app` (update is documented as a **partial/patch-style PUT**: "This API supports partial
  updates or patching of app configuration"). `configuration`/`parameters` are part of the app object
  itself (no separate parameter-endpoint dependency was needed).
- **Roles** (`/api/2/roles`) — full CRUD, plus `PUT /roles/{id}/apps` (**Set Role Apps**), which
  OneLogin's own docs state is a **full replace**: *"submit the complete list... don't submit a
  partial list of app IDs."* Role **user/admin** assignment (`/roles/{id}/users`,
  `/roles/{id}/admins`) is intentionally **excluded** — see below.
- **User Mappings** (`/api/2/mappings`) — full CRUD + `PUT /mappings/sort` (confirmed: *"All user
  mappings must be included to do a bulk sort... you will get an error"*).
- **App Rules** (`/api/2/apps/{id}/rules`) — full CRUD + `PUT /apps/{id}/rules/sort`, the same
  ordering contract as User Mappings, scoped per app.
- **Privileges** (`/api/1/privileges`) — full CRUD (`Version`/`Statement` policy document, confirmed
  via `create-privilege`'s example body) + role/user assignment. Assignment is **diff-reconciled**, not
  full-replace: `POST .../roles` **adds** a batch (`{"roles":[...]}`, confirmed via
  `assign-roles`/`assign-role`), while `DELETE .../roles/{role_id}` removes **one id at a time** — this
  app computes the declared-vs-live difference and issues exactly the add/remove calls needed.
  Requires a OneLogin subscription that includes **Delegated Administration**.
- **Account Brands** (`/api/2/branding/brands`) — full CRUD, confirmed via `create-account-brand`
  (full field list, including `master`) and `update-account-brand` (confirmed **partial** update: *"a
  JSON object that only contains the `name` field can be passed"*). The Branding API is an OneLogin
  **Early Preview** feature — *"may be subject to change... contact your account manager"* — and
  requires an API credential created after **2020-10-21**. The account's `master` brand is never
  created or deleted by this app.

### Intentionally excluded (this release)

| Surface | API | Why excluded |
| --- | --- | --- |
| Groups | `/api/1/groups` | **Confirmed read-only.** OneLogin's own docs: *"This API is read-only and supports GET operations only... to add a user to or remove a user from a group, use the Update User by ID API."* There is no create/update/delete for groups — they're directory-synced or admin-console-managed only. Not a gap in this app; genuinely not an API-writable resource. |
| Custom User Attribute Fields (definitions) | `/api/1/users/custom_attributes`, `/api/1/users/{id}/set_custom_attributes` | Verified there is **no create/update/delete for the field definition itself** — only `GET .../custom_attributes` (list existing shortnames) and `Set Custom Attribute` (which sets a **value** on one user, requiring the field to already exist). Field definitions are admin-console-only; this was a candidate in scope for research but turned out not to be a declarative config surface. |
| Smart Hooks | `/api/2/hooks` | Verified that `function` (the base64 JS code body) is **required on every create AND update call**, and is **never returned by GET** (write-only). A partial PUT that only changes `disabled`/`timeout`/`retries`/`options` would still have to resend the function body — which this app cannot read back to preserve, and code-body authoring is explicitly out of scope (treated like SOAR playbook code, per this app's brief). Managing Smart Hooks without owning the code is not genuinely possible here. |
| Multi-Factor Authentication | `/api/2/multi-factor-authentication/*` | Every endpoint (`enroll-factor`, `verify-factor`, `activate-factor`, `remove-factor`, ...) is a **per-user enrollment/verification action** — one-shot user lifecycle, not tenant-level policy configuration. OneLogin's MFA API exposes no account-wide "which factors are enabled" policy object. |
| Risk Rules / Vigilance AI, Smart MFA | (no confirmed public config endpoint) | Researched directly; found no documented, publicly-writable "risk policy"/"risk rule" configuration endpoint in the current API docs (unlike PingOne Protect's `/riskPolicySets`). Rather than fabricate an endpoint, this is left undeclared for a future pass if OneLogin documents one. |
| Role user/admin assignment | `/roles/{id}/users`, `/roles/{id}/admins` | Add/remove-only (no full-replace `set`, unlike Set Role Apps) — closer to a per-user lifecycle action than declarative org config, the same reasoning applied to per-user group membership across this app's sibling IAM apps. |
| App client secrets / signing material | `sso.client_secret`, SAML certificates | Server-generated and either omitted or returned once; treated as read-only/write-only-elsewhere everywhere in this app, matching the treatment of secrets in every other Veltrix IAM app. |
| Brand logo/background images | `/api/2/branding/brands` (`logo`, `background`) | Write API accepts base64 image data, but `GET` returns **CDN URL objects** instead (asymmetric in/out shapes) — true declarative round-tripping isn't possible; asset upload stays a manual admin-console step. |
| Users, Events, Reports | `/api/2/users`, `/api/1/events`, Reports | Per-user lifecycle/inventory and read-only audit data, not org-level declarative config — out of scope for the same reason every sibling Veltrix IAM app excludes general user lifecycle and read-only logs. |
| SAML Assertions, Self-Registration | (v2 API sections exist; no confirmed writable declarative surface found for either) | SAML Assertions is a request-time federation operation, not configuration. Self-Registration's documented API pages returned 404 during this research pass — deferred rather than guessed at. |

Verified directly against [developers.onelogin.com](https://developers.onelogin.com/) as of 2026-08.

## Ordering caveat

`reconcileOrder` (see `lib/oneLogin.ts`) only controls the **relative order of the mappings/rules this
canvas declares**, positioned as a group at the spot the first of them occupied before this deploy. It
does not — and cannot, given OneLogin's all-or-nothing Bulk Sort contract — guarantee an *absolute*
position independent of what other tooling does to the account's undeclared mappings/rules between
deploys.

## Health check

Handlers probe a lightweight `GET` on the relevant collection (`/api/2/apps`, `/api/2/roles`,
`/api/2/mappings`, `/api/1/privileges`, `/api/2/branding/brands`) — proving the API credential is valid
and correctly scoped — before doing any per-configuration-type work. Privileges additionally surfaces
a clear message when the account lacks a Delegated Administration subscription; Brands does the same
for the Branding Early Preview feature.

## References

- OneLogin API reference: <https://developers.onelogin.com/api-docs/2>
- OAuth 2.0 Tokens: <https://developers.onelogin.com/api-docs/2/oauth20-tokens/generate-tokens-2>
- Apps: <https://developers.onelogin.com/api-docs/2/apps>
- Roles: <https://developers.onelogin.com/api-docs/2/roles>
- User Mappings: <https://developers.onelogin.com/api-docs/2/user-mappings>
- App Rules: <https://developers.onelogin.com/api-docs/2/app-rules>
- Privileges (legacy v1): <https://developers.onelogin.com/api-docs/1/privileges>
- Branding (Early Preview): <https://developers.onelogin.com/api-docs/2/branding>
- Groups (read-only): <https://developers.onelogin.com/api-docs/1/groups>
- Smart Hooks: <https://developers.onelogin.com/api-docs/2/smart-hooks>
