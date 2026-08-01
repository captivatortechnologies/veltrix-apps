# 🔑 Delinea Secret Server

Manage [Delinea Secret Server](https://delinea.com/products/secret-server) — the
Privileged Access Management (PAM) vault — as code on the Veltrix
Security-as-Code platform. Author folder structure in the Configuration Canvas
and drive it through the pipeline (validate → deploy → rollback → health-check →
drift-detect → status).

## How it's managed

Secret Server exposes a uniform **REST API** over HTTPS. This app applies
configuration over that API:

- **Base URL** — the operator supplies the Secret Server base URL as the
  connection endpoint:
  - **On-prem**: `https://<host>/SecretServer`
  - **Cloud**: `https://<tenant>.secretservercloud.com`

  The app targets `<base>/api/v1/…` and authenticates at `<base>/oauth2/token`.
- **Authentication** — OAuth2 **password grant**: the app POSTs
  `grant_type=password` + the API user's `username` / `password` (form-encoded)
  to `<base>/oauth2/token`, then sends the returned `access_token` as
  `Authorization: Bearer <token>` on every REST call. The credential's
  **username** and **password** fields carry the API user. On-prem Secret Server
  commonly ships a **self-signed certificate**, which the transport tolerates
  (toggle with the `verify_tls` setting).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Folders** | Secret Server REST API (`/api/v1/folders`, `/api/v1/folders/{id}`) | ✅ v0.1.0 |

A folder is reconciled by its **name within a parent folder**: deploy searches
`/api/v1/folders`, matches on `folderName` + `parentFolderId`, then updates an
existing folder (`PATCH /api/v1/folders/{id}`) or creates a new one
(`POST /api/v1/folders`). The optional **parent folder name** is resolved to a
`parentFolderId` (root — `parentFolderId = -1` — when blank). Deploy snapshots
the prior folder body so rollback can restore it; a folder it created is left in
place (folder deletion is destructive).

## Setup

1. **API user** — in Secret Server, use (or create) a user that can administer
   the folders this app manages. Enable **Webservices** (Admin → Configuration →
   General → Application Settings → *Enable Webservices*).
2. **Credential** — store the API user's **username** and **password** as a
   Veltrix credential on the **Connections** page.
3. **Connection** — add a connection whose endpoint is your Secret Server base
   URL (on-prem `https://<host>/SecretServer`, cloud
   `https://<tenant>.secretservercloud.com`) and attach the credential. Use
   **Test** to verify the OAuth2 logon and API reachability. Saving the
   connection registers a `delinea-secret-server` deploy target.
4. **Author & deploy** — open the Configuration Canvas, pick **Folders**, author
   your folder tree, and deploy through the pipeline.

## Notes

Secret Server REST API paths and folder fields (`/api/v1/folders`,
`oauth2/token`, `folderName` / `parentFolderId` / `folderTypeId` /
`inheritPermissions` / `inheritSecretPolicy`) follow the documented v1 REST API
and should be **verified against a live Secret Server instance**. TLS
verification is off by default (on-prem self-signed) and configurable via the
`verify_tls` setting.

Apache-2.0.
