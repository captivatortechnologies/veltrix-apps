# Jamf (Veltrix app)

Manage [Jamf Pro](https://www.jamf.com/products/jamf-pro/) (Apple MDM /
endpoint management) configuration as code through the **modern Jamf Pro
API**, driven by the Veltrix Security-as-Code pipeline (validate → deploy →
health check → drift detect → rollback).

## What it manages

| Configuration type | Jamf Pro object | Jamf Pro API operations |
| --- | --- | --- |
| **Scripts** (`scripts`) | Scripts (shell/zsh payloads a policy runs at Before / After / At Reboot priority) | `GET /v1/scripts` (list), `GET /v1/scripts/{id}`, `POST /v1/scripts`, `PUT /v1/scripts/{id}`, `DELETE /v1/scripts/{id}` |

Reconciliation matches by **name**: `deploy` lists every script (the search
results already carry the full `Script` object, so no per-item `GET` is
needed), creates any that are missing, and updates any that already exist to
the declared spec — capturing the prior full state for rollback.

> **Name uniqueness.** Jamf Pro does **not** enforce unique script names
> server-side. This app's own canvas rejects duplicate names among the
> scripts *you* declare, but if the live tenant already has more than one
> script sharing a name (created outside Veltrix), the first one Jamf Pro
> returns is treated as the match.

### Why "Scripts" first

Scripts are entirely served by the modern, JSON-based Jamf Pro API and are
self-contained (no cross-references to other object types), which makes them
the natural first configuration type. **Policies, Smart Groups and
Configuration Profiles are intentionally out of scope for this release** —
Jamf Pro still serves those through the legacy Classic API (`/JSSResource/…`,
XML), a materially different integration surface planned for a follow-up
release.

## Authentication

Basic-auth-for-a-bearer-token. Create an **API-only account** in Jamf Pro
(**Settings → System → User Accounts & Groups**) with a **Custom** privilege
set granting Read/Create/Update/Delete under **Jamf Pro Server Objects →
Scripts**, then store it as a Veltrix credential:

- **Username** → the API-only account's username
- **Password** → the API-only account's password

The app exchanges these for a short-lived Bearer token:

```
POST https://<host>/api/v1/auth/token       Authorization: Basic base64(user:pass)
  -> 200 { "token": "<JWT>", "expires": "<ISO-8601 timestamp>" }
```

([Jamf Pro API reference](https://developer.jamf.com/jamf-pro/reference/post_v1-auth-token))
The token is cached and re-acquired shortly before `expires`; a `401` on any
subsequent call also forces one re-acquisition + retry (the token may have
been invalidated server-side, e.g. by a password change).

### OAuth2 client credentials (not used by this app — documented for completeness)

Jamf Pro 10.49+ also supports **API Roles and Clients** — an OAuth2
client-credentials flow:

```
POST https://<host>/api/v1/oauth/token       (form-encoded)
  grant_type=client_credentials&client_id=<id>&client_secret=<secret>
  -> 200 { "access_token": "<JWT>", "token_type": "Bearer", "expires_in": <seconds>, "scope": "api-role:<id> …" }
```

([Jamf Pro API reference](https://developer.jamf.com/jamf-pro/reference/postoauthtoken),
[Client Credentials guide](https://developer.jamf.com/jamf-pro/docs/client-credentials))
This app deliberately uses the username/password flow instead, because it
works against **every** Jamf Pro version this app supports (not just 10.49+)
and needs no additional Jamf Pro-side API Role/Client setup. Supporting API
Roles and Clients as an alternate credential shape is a natural follow-up.

## Component

Register a `jamf-pro-server` component whose **hostname** is your Jamf Pro
server, e.g. `yourcompany.jamfcloud.com` (Jamf Cloud) or an on-prem FQDN.
Requests go to `https://<host>/api` — for an on-prem install on a non-default
HTTPS port (e.g. Tomcat on `:8443`), set the component's port and it is
included in the URL.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for token + API calls. |
| `page_size` | `100` | Page size used when listing scripts (`GET /v1/scripts`, `page-size` query parameter). |

## Development

```
cd apps/jamf
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs jamf           # run handler tests
node ../../scripts/validate-app.mjs apps/jamf   # validate against the app contract
```
