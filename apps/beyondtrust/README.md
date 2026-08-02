# BeyondTrust (Veltrix app)

Manage **BeyondTrust Password Safe** (privileged access management) as code. Author
Password Safe **functional accounts**, BeyondInsight **user groups** and
**workgroups**, and drive them through the Veltrix Security-as-Code pipeline —
validate, deploy, health check, drift detection and rollback — over the
BeyondInsight / Password Safe public REST API.

- **Category:** IAM
- **Version:** 0.2.0
- **Target:** BeyondInsight / Password Safe (on-premises or cloud), public API `v3`

## What it manages

| Config type | Resource | Operations |
| --- | --- | --- |
| **Functional Accounts** | `/FunctionalAccounts` | create (if absent), list, delete (rollback) |
| **User Groups** | `/UserGroups` | create (if absent), list, delete (rollback) |
| **Workgroups** | `/Workgroups` | create (if absent), list — no delete endpoint |

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

## How it connects

The BeyondInsight API uses a **PS-Auth session**, not a per-request token:

1. `POST /Auth/SignAppIn` with header
   `Authorization: PS-Auth key=<api-key>; runas=<user>;` → HTTP 200 + a session
   cookie (`ASP.NET_SessionId`).
2. REST calls (`GET`/`POST`/`DELETE /FunctionalAccounts`) carry that **cookie**.
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

Password Safe has **no update (PUT) endpoint** for functional accounts. Deploy is
therefore a **create-if-absent upsert**: an account already present on its
`(PlatformID, DomainName, AccountName)` identity is left untouched and reported;
changing an existing account requires delete + recreate (which loses the stored
secret) and is never done implicitly. Rollback deletes exactly the accounts a
deploy created; an account that has since been referenced by a managed system
(`SystemReferenceCount > 0`) is skipped rather than force-deleted.

## Verify against a live BeyondTrust

This is a **v0.1.0 foundation**. The following were confirmed from the official
BeyondInsight / Password Safe API documentation but should be validated against a
live instance before production use:

- The exact SignAppIn/Signout session-cookie behaviour and whether the API key
  must ALSO be resent on subsequent calls (this app relies on the cookie only).
- The `/FunctionalAccounts` create body's conditional fields (`Password`, `Secret`,
  `APIKey`, `TenantID`, `ObjectID`) which depend on the target platform's
  configuration.
- Whether the list endpoint returns a plain array or a paginated `{ Data: [] }`
  container (this app handles both).
- Sending `pwd=` in the PS-Auth header when the API registration requires a user
  password (not sent by default here).

## Sources

- BeyondInsight and Password Safe API usage (auth, base URL, PS-Auth header):
  <https://docs.beyondtrust.com/bips/reference/beyondinsight-and-password-safe-api-usage>
- Create functional account: `POST /api/public/v3/functionalaccounts`
- List functional accounts: `GET /api/public/v3/functionalaccounts`
- Delete functional account: `DELETE /api/public/v3/functionalaccounts/{id}`
- Sign in / out: `POST /api/public/v3/auth/signappin`, `POST /api/public/v3/auth/signout`
- User groups (BeyondInsight group): `POST` / `GET /api/public/v3/usergroups`,
  `DELETE /api/public/v3/usergroups/{id}` — BeyondInsight APIs reference,
  <https://docs.beyondtrust.com/bips/v24.3/docs/beyondinsight-api> (groupName max
  200, description required max 255)
- Workgroups: `POST` / `GET /api/public/v3/workgroups` (Name max 256, optional
  OrganizationID GUID) — no `PUT`/`DELETE` documented for the Workgroups resource
