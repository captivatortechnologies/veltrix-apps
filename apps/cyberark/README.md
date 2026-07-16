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

## Authentication — the PVWA logon flow

CyberArk has no static API key. The app authenticates with a **manager service
account** through the logon flow:

1. `POST /PasswordVault/API/auth/{method}/Logon` with `{ username, password, concurrentSession: true }`
   — `{method}` is **CyberArk** (default), **LDAP** or **RADIUS**, chosen in the
   app settings. The response body is a **bare session-token string**.
2. That token is sent as the **raw `Authorization: <token>`** header (no `Bearer`
   prefix) on every subsequent call.
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

## Write-only secret (accounts)

The account `secret` (password / SSH key) is **write-only**:

- it is sent to CyberArk **only when an account is first created**;
- CyberArk never returns it on read, so it is **never read back, diffed, or
  stored** in rollback data, artifacts or logs;
- existing accounts' secrets are **left untouched** — rotate them through
  CyberArk's own change-password workflow. This app does not manage rotation.

## Development

```bash
cd apps/cyberark
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs cyberark          # unit tests
node ../../scripts/validate-app.mjs apps/cyberark  # contract validation
```
