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

| Type | Sidebar group | Surface | Status |
|---|---|---|---|
| **Folders** | Vault Structure | `/api/v1/folders[/{id}]` | ✅ v0.1.0 |
| **Secret Policies** | Vault Structure | `/api/v1/secret-policy` | ✅ v0.2.0 |
| **Groups** | Access & Identity | `/api/v1/groups[/{id}]` | ✅ v0.2.0 |
| **Users** | Access & Identity | `/api/v1/users[/{id}]` | ✅ v0.3.0 (existing users only, no password) |
| **IP Address Restrictions** | Access & Identity | `/api/v1/ipaddress-restrictions[/{id}]` | ✅ v0.3.0 |
| **Sites** | Distributed Engines | `/api/v1/distributed-engine/site[s][/{id}]` | ✅ v0.3.0 |
| **Connection Managers** | Distributed Engines | `/api/v1/distributed-engine/site-connector[s][/{id}]` | ✅ v0.3.0 |
| **Distributed Engine Configuration** | Distributed Engines | `/api/v1/distributed-engine/configuration` (singleton) | ✅ v0.3.0 |

A **folder** is reconciled by its **name within a parent folder**: deploy
searches `/api/v1/folders`, matches on `folderName` + `parentFolderId`, then
updates an existing folder (`PATCH /api/v1/folders/{id}`) or creates a new one
(`POST /api/v1/folders`). The optional **parent folder name** is resolved to a
`parentFolderId` (root — `parentFolderId = -1` — when blank). Deploy snapshots
the prior folder body so rollback can restore it; a folder it created is left in
place (folder deletion is destructive). **Secret policies**, **groups**,
**sites**, **connection managers** and **IP address restrictions** are all
reconciled the same way — upsert by name, prior state snapshotted for
rollback, a newly created record left in place on rollback (this app never
deletes). **Users** update existing accounts only (see Coverage below). The
**Distributed Engine Configuration** is a tenant-wide singleton — it always
exists, so deploy always updates and never creates.

## Coverage (v0.3.0)

Coverage was audited against the documented Secret Server v1 REST API, using
the Delinea/Thycotic `Thycotic.SecretServer` PowerShell module source
(`thycotic-ps/thycotic.secretserver`) as the verification reference for every
endpoint path, HTTP verb and request-body field name below.

### Secret handling — explicit

This is a **Privileged Access Management** app. It manages the vault's
*structure and configuration*, never the *contents it protects*:

- **No config type ever reads, writes, stores or transmits a secret's actual
  contents** (passwords, private keys, API keys, certificates held in
  Secret Server). No config type calls a `/secrets/*` endpoint.
- **Users never carries a password.** Creating a local Secret Server user
  over REST requires a `password` field; this app treats that as a
  secret-handling anti-pattern and refuses to do it. The Users config type
  manages profile attributes (display name, email, active state,
  application-account flag) for **existing** users only — a user that does
  not exist is a hard deploy failure with a clear message pointing at manual
  provisioning or Active Directory sync.
- **Connection Managers never reads or writes the connector's own
  service-account credential**, exposed at
  `GET /api/v1/distributed-engine/site-connector/{id}/credentials`. That
  credential is generated/managed by Secret Server itself; this app only
  manages the connector's name, hostname, transport and TLS settings.
- **Sites' `powershellRunAsSecretId` is a plain numeric reference** to an
  existing secret's ID — the same pattern Folders already uses for a parent
  folder *name* — never the secret's contents.
- The app's own credential to Secret Server (an API user's username/password)
  is handled exactly like every other Veltrix app credential: stored
  encrypted by the platform's Credential Vault, never logged, decrypted only
  per-request inside a handler.

### Managed declarative configuration

| Configuration type | Secret Server REST operations |
| --- | --- |
| Folders | search `GET /folders`; create `POST /folders`; update `PATCH /folders/{id}` |
| Secret Policies | search `GET /secret-policy/search`; create `POST /secret-policy`; update `PATCH /secret-policy/{id}` (grid-patch) |
| Groups | search `GET /groups`; create `POST /groups`; update `PUT /groups/{id}` |
| Users | search `GET /users`; update `PUT /users/{id}` (full-object merge) — **no create, no password** |
| IP Address Restrictions | list `GET /ipaddress-restrictions`; create `POST /ipaddress-restrictions`; update `PUT /ipaddress-restrictions/{id}` |
| Sites | search `GET /distributed-engine/sites`; create `POST /distributed-engine/site`; update `PATCH /distributed-engine/site/{id}` (grid-patch) |
| Connection Managers | search `GET /distributed-engine/site-connectors`; create `POST /distributed-engine/site-connector`; update `PATCH /distributed-engine/site-connector/{id}` (grid-patch) |
| Distributed Engine Configuration | read `GET /distributed-engine/configuration`; update `PATCH /distributed-engine/configuration` (grid-patch, singleton) |

Every upsert-style type snapshots the prior record for rollback; a record
this app *created* is left in place on rollback (deletion is destructive and
not managed by this app for any type).

### Intentionally excluded — researched and dropped

These candidates were verified against the same PowerShell-module source and
explicitly **not** implemented, with reasons:

- **Roles** — the module (and the documented REST surface) exposes only
  `Search-TssRole` (`GET /api/v1/roles`, filterable by user/group). No
  create/update/delete endpoint exists. A role's permission set is a complex
  ACL structure managed in the Secret Server Admin UI, not a simple
  declarative record.
- **Secret Templates** — `New-TssSecretTemplate` requires the **full field
  schema** (including password-generator rules) in a single create call —
  there is no "create with just a name" path, so it does not fit this app's
  upsert-by-name model. `Set-TssSecretTemplate` only toggles the `active`
  flag; there is no supported endpoint to update a template's fields after
  creation. Templates directly govern password-type field generation
  policy — adjacent to secret material and out of scope for a first pass.
- **Secret Policy Assignments** (assigning a named policy to a folder by
  ID) — the only exposed field is `secretPolicy` on `Set-TssFolder`, which
  targets the **legacy singular** `PATCH /api/v1/folder/{id}` endpoint with a
  grid-patch body — a different endpoint, with a different body shape, than
  the plural `/api/v1/folders/{id}` endpoint this app's Folders type already
  uses and has verified. Introducing a second, divergent REST convention for
  one field was judged too risky without live-instance verification. The
  folder-level inheritance toggle (`inheritSecretPolicy`) is already covered
  by the Folders config type.
- **Event Subscriptions / Webhooks** (Event Pipelines) — the module exposes
  only `Enable`/`Disable`/`Search`/`Get` for existing, system-defined event
  pipelines, plus assigning an existing pipeline to an existing "Event
  Pipeline Policy". **No create endpoint exists** for either a pipeline or a
  policy (no `New-TssEventPipeline*` cmdlet). Pipeline definitions (created
  in the Admin UI) carry destination endpoint credentials (webhook auth
  tokens, Syslog server credentials) — out of scope for a PAM app that must
  not handle secret material, and not creatable via this API surface anyway.
- **Individual Distributed Engine registration** (`Register`/`Unregister`/
  `Update-TssDistributedEngine`) — an engine is a physical/agent install that
  activates against an existing Site; it is not something this app creates
  via API, the same way BYOL infrastructure nodes are provisioned outside a
  config-as-code pipeline in other Veltrix apps. The tenant-wide feature
  configuration those engines share **is** covered by the Distributed Engine
  Configuration config type.

## Setup

1. **API user** — in Secret Server, use (or create) a dedicated API user whose
   permissions are scoped to what this app manages. Enable **Webservices**
   (Admin → Configuration → General → Application Settings →
   *Enable Webservices*).
2. **Credential** — store the API user's **username** and **password** as a
   Veltrix credential on the **Connections** page.
3. **Connection** — add a connection whose endpoint is your Secret Server base
   URL (on-prem `https://<host>/SecretServer`, cloud
   `https://<tenant>.secretservercloud.com`) and attach the credential. Use
   **Test** to verify the OAuth2 logon and API reachability. Saving the
   connection registers a `delinea-secret-server` deploy target.
4. **Author & deploy** — open the Configuration Canvas, pick a configuration
   type (grouped under **Vault Structure**, **Access & Identity** and
   **Distributed Engines** in the sidebar), author your configuration, and
   deploy through the pipeline.

## Notes

Secret Server REST API paths and field names follow the documented v1 REST
API — verified against the Delinea/Thycotic `Thycotic.SecretServer`
PowerShell module source where the public docs are thin — and should be
**verified against a live Secret Server instance** before production use.
Several fields are explicitly flagged as unverified in code/CHANGELOG where
the module itself does not exercise them end-to-end (e.g. the Groups
`PUT`-update verb, the Connection Managers name-field asymmetry, the Users
`domainId` directory-managed sentinel). TLS verification is off by default
(on-prem self-signed) and configurable via the `verify_tls` setting.

Apache-2.0.
