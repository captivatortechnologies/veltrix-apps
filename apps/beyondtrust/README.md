# BeyondTrust (Veltrix app)

Manage **BeyondTrust Password Safe** (privileged access management) as code. Author
Password Safe **functional accounts**, **managed systems**, **managed accounts**,
BeyondInsight **user groups**, **workgroups**, **directories**, **address groups**
and **attributes**, and drive them through the Veltrix Security-as-Code pipeline —
validate, deploy, health check, drift detection and rollback — over the
BeyondInsight / Password Safe public REST API.

- **Category:** IAM
- **Version:** 0.3.0
- **Target:** BeyondInsight / Password Safe (on-premises or cloud), public API `v3`

## What it manages

| Config type | Resource | Operations |
| --- | --- | --- |
| **Functional Accounts** | `/FunctionalAccounts` | create (if absent), list, delete (rollback) |
| **User Groups** | `/UserGroups` | create (if absent), list, delete (rollback) |
| **Workgroups** | `/Workgroups` | create (if absent), list — no delete endpoint |
| **Managed Systems** | `/Workgroups/{id}/ManagedSystems` | create (if absent), list — no confirmed delete endpoint |
| **Managed Accounts** | `/ManagedSystems/{id}/ManagedAccounts`, `/ManagedAccounts/{id}` | create, **update**, list, delete |
| **Directories** | `/Workgroups/{id}/Directories`, `/Directories/{id}` | create, **update**, list, delete |
| **Address Groups** | `/AddressGroups`, `/AddressGroups/{id}/Addresses` | create group, **reconcile membership**, list, delete |
| **Attributes** | `/AttributeTypes`, `/AttributeTypes/{id}/Attributes` | create (if absent) at both tiers, list, delete (value only) |

Functional accounts are the service accounts Password Safe uses to manage systems.
Each account declares a **Platform ID**, an **account name** (without the domain),
an optional **domain**, and presentation/elevation fields (display name,
description, elevation command) plus an optional **password** that is sent only on
create and never read back.

**User groups** are the BeyondInsight **BeyondInsight-type** groups (group name,
description, active flag) that carry Password Safe roles and Smart Rule access —
Active Directory / LDAP / Entra ID groups need a bound directory and are out of
scope. Feature permissions and Smart Rule access are **not** managed here; a group
is created without them and an admin grants them in BeyondInsight.

**Workgroups** are the containers that organize assets and managed systems (name,
optional organization GUID). Password Safe has **no update or delete endpoint** for
a workgroup, so deploy is create-if-absent and rollback cannot remove a created
workgroup — it reports which ones remain for manual removal.

**Managed systems** are Password Safe's record of a system it manages credentials
for — declared here scoped to an **existing workgroup** (referenced by name, not
an Asset/Database, which would be an un-authorable discovered parent). Fields
cover platform id, timeout/port, an Active-Directory-only account name format,
password/DSS key rule references, release-duration policy and auto-management
flags. Some platforms need additional conditional fields this app does not model —
verify against your target platform. Create-if-absent; no confirmed update or
delete endpoint, so rollback reports created systems for manual removal.

**Managed accounts** are the individual credentials Password Safe manages on a
system — declared here scoped to an **existing managed system** (referenced by
name). **Always auto-managed**: this config type never sends a `Password`,
`PrivateKey` or `Passphrase` — Password Safe generates and rotates the secret
itself. Unlike every other config type in this app, Password Safe exposes a real
update and delete endpoint here, so deploy is a genuine upsert and rollback
restores prior field values (not just deletes what it created).

**Directories** bind an Active Directory / LDAP domain to an existing workgroup
for account discovery — platform, domain, forest, NetBIOS name and connection
settings. **Never a bind credential**: BeyondInsight models the AD/LDAP query
credential as a separate "Directory Credential" resource, provisioned out of
band in the console. A real upsert with restore-on-rollback, same shape as
managed accounts.

**Address groups** are named IP address / range collections used to scope access
policies and Smart Rules. The declared address list is **authoritative** —
reconciled against the live group's membership on every deploy (additions and
removals), the only config type in this app with that semantic.

**Attributes** are a two-tier taxonomy (attribute type / category, e.g.
"Environment", plus attribute values, e.g. "Production") used to tag managed
accounts and systems for Smart Rule scoping. One item declares both the value and
the name of its type; the type is created if absent and **shared** — never
deleted by rollback, since deleting it would cascade to every value under it.

## How it connects

The BeyondInsight API uses a **PS-Auth session**, not a per-request token:

1. `POST /Auth/SignAppIn` with header
   `Authorization: PS-Auth key=<api-key>; runas=<user>;` → HTTP 200 + a session
   cookie (`ASP.NET_SessionId`).
2. REST calls (`GET`/`POST`/`PUT`/`DELETE`) carry that **cookie**.
3. `POST /Auth/Signout` ends the session.

The base URL is `https://<host>/BeyondTrust/api/public/v3`. On-premises BeyondInsight
commonly ships a self-signed certificate, so the transport tolerates untrusted
certs (`verify_tls` setting, off by default).

### Credential

Store, as a Veltrix connection credential:

- **API key** (the token) — from BeyondInsight **Configuration → API Registrations**.
- **Run-as user** (the username) — a BeyondInsight user with API access.
- **User password** — only if the API registration has "User Password" enabled
  (this foundation does not send `pwd=` by default; see the flag below).

The **Connections** page (SDK `ConnectionsManager`) captures all of this and runs a
per-row connectivity test; saving a connection registers a
`beyondtrust-passwordsafe` deploy-target component.

## Deploy semantics

Password Safe has **no update (PUT) endpoint** for functional accounts, user
groups or workgroups, so those three are a **create-if-absent upsert**: an item
already present on its identity is left untouched and reported; changing it means
delete + recreate and is never done implicitly. Managed systems inherit the same
posture (create-if-absent; no confirmed delete). **Managed accounts** and
**directories** are the exception — Password Safe DOES expose an update endpoint
for both, so those two are a **real upsert** (create or update), and rollback
restores the prior field values for an item they changed. **Address groups**
go further still: membership is authoritative and reconciled (add/remove) on
every deploy.

An account referenced by a managed system (`SystemReferenceCount > 0`) is skipped
rather than force-deleted on rollback; the same "leave it rather than break a live
credential" posture applies to every delete/restore path added since — a failed
delete or restore is always skipped, never allowed to fail the whole rollback.

## Verify against a live BeyondTrust

This is a **v0.3.0** app. The following were confirmed from the official
BeyondInsight / Password Safe API documentation but should be validated against a
live instance before production use:

- The exact SignAppIn/Signout session-cookie behaviour and whether the API key
  must ALSO be resent on subsequent calls (this app relies on the cookie only).
- The `/FunctionalAccounts` create body's conditional fields (`Password`, `Secret`,
  `APIKey`, `TenantID`, `ObjectID`) which depend on the target platform's
  configuration; the same platform-conditional caveat applies to Managed Systems.
- Whether a list endpoint returns a plain array or a paginated `{ Data: [] }`
  container (every config type in this app handles both).
- Sending `pwd=` in the PS-Auth header when the API registration requires a user
  password (not sent by default here).
- Whether `DELETE /ManagedSystems/{id}` exists at all (not found in the public API
  reference — Managed Systems rollback deliberately never attempts a delete).
- The precise `DELETE /Directories/{id}` path shape (rollback wraps it in a
  try/catch and skips on failure either way).

## Coverage (v0.3.0)

Coverage was audited against the BeyondInsight and Password Safe public v3 API
reference (`docs.beyondtrust.com/bips` and the per-endpoint
`beyondtrust.com/docs/beyondinsight-password-safe/ps/api` reference pages).

### Managed declarative configuration

| Configuration type | Password Safe API operations |
| --- | --- |
| Functional Accounts | `GET`/`POST /FunctionalAccounts`, `DELETE /FunctionalAccounts/{id}` |
| User Groups | `GET`/`POST /UserGroups`, `DELETE /UserGroups/{id}` |
| Workgroups | `GET`/`POST /Workgroups` (no update/delete) |
| Managed Systems | `GET /Workgroups`, `GET /ManagedSystems`, `POST /Workgroups/{id}/ManagedSystems` (no confirmed update/delete) |
| Managed Accounts | `GET /ManagedSystems`, `GET/POST /ManagedSystems/{id}/ManagedAccounts`, `PUT`/`DELETE /ManagedAccounts/{id}` |
| Directories | `GET /Workgroups`, `GET /Directories`, `POST /Workgroups/{id}/Directories`, `PUT`/`DELETE /Directories/{id}` |
| Address Groups | `GET`/`POST /AddressGroups`, `GET`/`POST /AddressGroups/{id}/Addresses`, `DELETE /Addresses/{id}`, `DELETE /AddressGroups/{id}` |
| Attributes | `GET`/`POST /AttributeTypes`, `GET`/`POST /AttributeTypes/{id}/Attributes`, `DELETE /Attributes/{id}` |

### Re-evaluated and intentionally excluded

- **Access Policies** — `GET /AccessPolicies` (list) and `POST /AccessPolicies/Test`
  (evaluate access to a managed account) are the only documented operations.
  There is no create/update endpoint; a policy is authored through a full
  schedule/rule editor in the BeyondInsight console the public API doesn't expose
  for writes. Not authorable as code.
- **Applications** — `GET /Applications` / `GET /Applications/{id}` only; the
  registered-application catalog is fixed. Linking an existing application to a
  managed account (`POST`/`DELETE /ManagedAccounts/{id}/Applications`) is a
  sub-resource operation on an already-declarative parent, not a standalone
  entity worth its own config type.
- **DSS Key Rules** and **Password Rules** — `GET` only across every documented
  API version (6.10 through 24.1); no create/update/delete. Referenced BY ID from
  Managed Systems/Accounts/Directories in this app (`dssKeyRuleId`,
  `passwordRuleId`), never authored.
- **Smart Rules / Quick Rules** — creation needs a full filter/action definition
  the public API does not model as a simple writable body (same reasoning as the
  v0.2.0 note). Left out rather than shipped half-working.
- **Secret material** — a managed account's `Password`/`PrivateKey`/`Passphrase`
  and a directory's bind username/password are never modeled. Managed Accounts is
  auto-managed-only (Password Safe generates and rotates the secret); a
  directory's bind credential is a separate "Directory Credential" BeyondInsight
  resource, provisioned out of band. This app never asks an operator to paste a
  live secret into a canvas field.
- **Requests / Sessions / ISA Requests**, **credential release** (`GET
  /Credentials/{requestId}`) and **keystroke/session monitoring** are imperative,
  point-in-time operations (checking out a password, starting a session), not
  durable desired state.

## Sources

- BeyondInsight and Password Safe API usage (auth, base URL, PS-Auth header):
  <https://docs.beyondtrust.com/bips/reference/beyondinsight-and-password-safe-api-usage>
- REST API guide (endpoint index): <https://docs.beyondtrust.com/bips/v24.3/docs/api>,
  <https://docs.beyondtrust.com/bips/v24.3/docs/password-safe-api>
- Functional accounts: `POST`/`GET`/`DELETE /api/public/v3/functionalaccounts`
- User groups: `POST`/`GET /api/public/v3/usergroups`, `DELETE
  /api/public/v3/usergroups/{id}` (groupName max 200, description required max 255)
- Workgroups: `POST`/`GET /api/public/v3/workgroups` (Name max 256, optional
  OrganizationID GUID) — no `PUT`/`DELETE` documented
- Managed systems: `POST /api/public/v3/workgroups/{id}/managedsystems`,
  `GET /api/public/v3/managedsystems` —
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/password-safe/managed-systems/post-workgroups.htm>
- Managed accounts: `POST /api/public/v3/managedsystems/{id}/managedaccounts`,
  `PUT`/`DELETE /api/public/v3/managedaccounts/{id}` —
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/password-safe/provisioning/post-managedsystems.htm>,
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/password-safe/provisioning/delete-managedaccounts.htm>
- Directories: `POST /api/public/v3/workgroups/{id}/directories`,
  `PUT /api/public/v3/directories/{id}` —
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/password-safe/directories.htm>
- Address groups: `GET`/`POST`/`PUT`/`DELETE /api/public/v3/addressgroups`,
  `GET`/`POST /api/public/v3/addressgroups/{id}/addresses`,
  `DELETE /api/public/v3/addresses/{id}`
- Attributes / attribute types: `GET`/`POST /api/public/v3/attributetypes`,
  `GET`/`POST /api/public/v3/attributetypes/{id}/attributes`,
  `DELETE /api/public/v3/attributes/{id}` —
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/beyond-insight/attribute-types.htm>,
  <https://www.beyondtrust.com/docs/beyondinsight-password-safe/ps/api/beyond-insight/attributes.htm>
- Access policies (dropped): `GET /api/public/v3/accesspolicies`,
  `POST /api/public/v3/accesspolicies/test` — no create/update endpoint documented
