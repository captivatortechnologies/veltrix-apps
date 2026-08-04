# CyberArk Privileged Access Manager

Manage CyberArk Privileged Access Manager (PVWA) configuration as code through the
Privileged Access Security Web Services REST API, driven by the Veltrix
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

## What it manages

| Configuration type | CyberArk resource | Identity | Notes |
| --- | --- | --- | --- |
| **CyberArk Safes** | `/PasswordVault/API/Safes` | safe name | Retention (versions **or** days), managing CPM, OLAC, auto-purge. OLAC can be enabled but CyberArk does not allow disabling it once set. |
| **CyberArk Safe Members** | `/PasswordVault/API/Safes/{safe}/Members` | (safe, member) | Grants a User / Group / Role a set of authorizations. The 22 Gen2 permission keys are selected as a multiselect and expanded into the flat boolean object the API expects. |
| **CyberArk Accounts** | `/PasswordVault/API/Accounts` | (name, safe) | Privileged accounts. The **secret is write-only** (see below). Properties are updated with JSON-Patch (`op`/`path`/`value`). |
| **CyberArk Account Groups** | `/PasswordVault/API/AccountGroups` | (safe, group name) | Group-based credential rotation. Members are declared as (account name, safe) and resolved to CyberArk's internal AccountID at deploy time. **No REST delete-group endpoint** — see Coverage. |
| **CyberArk Platforms** | `/PasswordVault/API/Platforms/Targets` | PlatformID | Imported from a package when missing, activated/deactivated to the desired state. |
| **CyberArk Platform Session Policy** | `/PasswordVault/API/Platforms/Targets/{id}/PrivilegedSessionManagement` | platform id (singleton) | PSM server + connector enablement for a platform — a read/replace singleton, never created or deleted. |
| **CyberArk Onboarding Rules** | `/PasswordVault/API/AutomaticOnboardingRules` | rule name | Filters discovered accounts and onboards matches to a target Safe/platform. |
| **CyberArk Applications** | `/PasswordVault/WebServices/PIMServices.svc/Applications` | AppID | AAM/CCP application identities + their authentication methods (path / hash / OS user / **machine address** / certificate serial number / certificate attributes). |
| **CyberArk Directory Mappings** | `/PasswordVault/API/Configuration/LDAP/Directories/{id}/Mappings` | (directory name, mapping name) | LDAP/AD group → Vault group + authorization mappings, on an **existing** directory. |
| **CyberArk Vault Users** | `/PasswordVault/API/Users` | username | Vault identities. The **initial password is write-only** (see below). |
| **CyberArk Vault Groups** | `/PasswordVault/API/UserGroups` | group name | Vault groups + membership. Fully create/update/delete reversible. |
| **CyberArk Allowed Referrers** | `/PasswordVault/API/Configuration/AccessRestriction/AllowedReferrers` | referrer URL | PVWA's server-wide HTTP-referrer allow-list. **Create-only** — see Coverage. |

## Authentication — the PVWA logon flow

CyberArk has no static API key. The app authenticates with a **manager service
account** through the logon flow:

1. `POST /PasswordVault/API/auth/{method}/Logon` with `{ username, password, concurrentSession: true }`
   — `{method}` is **CyberArk** (default), **LDAP** or **RADIUS**, chosen in the
   app settings. The response body is a **bare session-token string**.
2. That token is sent as the **raw `Authorization: <token>`** header (no `Bearer`
   prefix) on every subsequent call — the same header the classic
   `/WebServices/PIMServices.svc` Applications endpoints accept, so the
   Applications config type reuses one session across both API generations.
3. `POST /PasswordVault/API/auth/Logoff` releases the session when the handler
   finishes.

The client performs the logon once per handler invocation, caches the token, and
reuses it. The base URL is `https://<pvwa-host>/PasswordVault/API`, where
`<pvwa-host>` is the `cyberark-pvwa` component's hostname.

## Setup

1. **Manager account** — provision a CyberArk service account whose Vault
   authorizations are scoped to the safes/accounts this app manages.
2. **Credential** — store the account's **username** and **password** in a Veltrix
   credential (`username` + `password` fields).
3. **Component** — register a `cyberark-pvwa` component whose hostname is the PVWA
   web server (e.g. `pvwa.example.com`) and attach the credential.
4. **Settings** — pick the logon method (`CyberArk` / `LDAP` / `RADIUS`) and,
   optionally, the request timeout.

PVWA is served over HTTPS and typically presents an internal certificate — the
platform host must trust the PVWA certificate.

## Write-only secrets

Two config types carry a write-only secret; both follow the same rule:

| Config type | Field | Sent | Never |
| --- | --- | --- | --- |
| **Accounts** | `secret` (password / SSH key) | Only when the account is first **created** | Read back, diffed, or stored in rollback data, artifacts or logs. Existing accounts' secrets are left untouched — rotate via CyberArk's own change-password workflow. |
| **Vault Users** | `initial_password` | Only when the user is first **created** | Read back, diffed, or stored. `POST /Users/{id}/ResetPassword` is intentionally NOT exposed by this app — rotation is out of scope. |

CyberArk never returns either field on read, so there is nothing to diff or
restore even in principle — this app does not choose to omit them, the API
makes that choice for it.

A third type carries a write-only, non-password secret with the identical
rule: **Platforms**' `import_package` (a BASE 64 platform `.zip`), sent only
when importing a missing platform, never read back or stored.

## Coverage

What this app manages, what it deliberately does not, and why. Built
research-first against the PVWA REST API (Gen2 `/PasswordVault/API` and,
for Applications, the classic `/PasswordVault/WebServices/PIMServices.svc`),
cross-checked against a community endpoint catalog covering the same
product line.

### Managed (12 configuration types)

Safes, Safe Members, Accounts, Account Groups, Platforms, Platform Session
Policy, Onboarding Rules, Applications (incl. allowed machines), Directory
Mappings, Vault Users, Vault Groups, Allowed Referrers — see the table above
for each one's endpoint and identity key.

### Excluded, with reasons

| Surface | Why excluded |
| --- | --- |
| **LDAP directory connection** (create/update a directory) | Requires a `BindPassword` — the directory's own bind-account secret. This app manages Directory **Mappings** hung off an existing, already-provisioned directory, never the directory connection itself. |
| **PTA (Privileged Threat Analytics) administration & security config** | (1) PTA uses a **separate authentication/session** from the PVWA logon flow this client models — a distinct token exchange this app does not implement. (2) Its one structured write endpoint (Global Catalog connectivity) needs an **LDAP bind password**. (3) Its administration/security endpoints are opaque `PATCH .../properties/{key}` calls on a free-form property bag, not a stable typed resource — not a "genuinely declarative" surface at the bar this app holds itself to. |
| **Vault user password reset** (`POST /Users/{id}/ResetPassword`) | Credential rotation — this app never manages secret rotation for any resource (mirrors the Accounts secret rule). |
| **Account Groups: deleting the group object** | CyberArk's Gen2 `AccountGroups` API exposes **no delete-group endpoint** — only membership can be removed over REST. A group this app creates can have its membership cleared on rollback, but the group object itself remains until removed via the PVWA UI or Vault admin CLI. Documented in code, canvas help text, and the rollback result message. |
| **Applications: updating an existing application's own fields** | No verified `PUT`/update endpoint exists for AppID/Description/Location/access-window/business-owner over the classic Web Services in the sources available to this app. Only authentication methods (a true child collection with its own POST/DELETE) are reconciled on an existing application; a top-level field mismatch is reported as informational drift, not silently ignored. |
| **Allowed Referrers: updating or deleting an existing entry** | Only `GET`/`POST` are confirmed for this endpoint. An existing entry's `regularExpression` flag cannot be changed by this app (reported as informational drift); rollback deletion of an entry this app created is attempted best-effort and never fails the batch if unconfirmed. |
| **Directory Mappings: reordering** (`POST .../Mappings/Reorder`) | Requires submitting the FULL ordered id list of every mapping in the directory, including ones this app doesn't manage — a real risk of silently reordering or displacing mappings outside its scope. |
| **Group / Rotational / Dependent / Stored platform variants**, **Connection Component import** | Same import/activate/duplicate shape as Target Platforms, but for specialized, narrower features (credential-rotation groups, dependent/stored platform packages, custom PSM connector packages). Deferred to a future pass rather than rushed. |
| **Master Policy — the non-session privileged-access workflow settings** (dual control, exclusive check-in/check-out, one-time password access, reason-for-access) | Still unconfirmed writable in the sources available to this app — only the **session-management (PSM)** slice of that surface was found to have a dedicated write endpoint (`cyberark-platform-session-policy`), which corrects the 1.2.0 note that the whole surface was read-only. |

### Secret handling, explicit

- **Never read back, diffed, or stored**: `cyberark-accounts.secret`,
  `cyberark-vault-users.initial_password`, `cyberark-platforms.import_package`
  — every one of these is sent to CyberArk on create only, and CyberArk itself
  never returns them on read, so drift detection and rollback structurally
  cannot see them.
- **Never modeled at all**: LDAP `BindPassword` (directory creation is
  excluded), PTA's `ldapPassword` (PTA config is excluded), any
  password-reset endpoint (accounts and Vault users both — rotation is out of
  scope everywhere in this app).
- **Never a credential**: an Application's authentication methods
  (path/hash/OS user/machine address/certificate attributes) PROVE a caller's
  identity — they are physical/identity constraints, not secrets, and are
  fully read/diffed/stored like any other declarative field.

## Development

```bash
cd apps/cyberark
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs cyberark          # unit tests
node ../../scripts/validate-app.mjs apps/cyberark  # contract validation
```
