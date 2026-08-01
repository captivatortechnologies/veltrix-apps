# Akamai (Veltrix app)

Manage **Akamai edge security as code**. Author **Network Lists** — shared sets of
IP addresses / CIDR blocks (`IP`) or two-letter country codes (`GEO`) — and drive
them through the Security-as-Code pipeline (validate → deploy → health check →
drift detect → rollback) over the **Akamai Network Lists API v2**, authenticated
with **EdgeGrid (EG1-HMAC-SHA256)** request signing.

- **Category:** NETWORK
- **Version:** 0.1.0
- **Component type:** `akamai`

## What it manages

| Configuration type | What it does |
| --- | --- |
| **Network Lists** | Create / update / delete a named `IP` or `GEO` list and sync its elements (upsert by list name). |

> **Out of scope for v0.1.0:** _activating_ a network list to STAGING / PRODUCTION
> is a separate Akamai step. This app manages list **content** only. A newly
> created list is inactive, so rollback can safely delete it.

## Authentication — EdgeGrid credentials

Akamai OPEN APIs use **EdgeGrid** request signing. Create an API client in
**Akamai Control Center → Identity & access** with authorization for the
**Network Lists** API, then download its `.edgerc`. It contains four values that
map onto a Veltrix connection + credential:

| `.edgerc` value | Veltrix field | Notes |
| --- | --- | --- |
| `host` | connection **Endpoint** | The API host, e.g. `akab-xxxx.luna.akamaiapis.net`. The base URL is `https://<host>`. |
| `client_token` | credential **username** | Public client identifier. |
| `access_token` | credential **API token** | Public access identifier. |
| `client_secret` | credential **password** | The true secret — used as the HMAC signing material. |

Each request is signed with an `Authorization: EG1-HMAC-SHA256
client_token=…;access_token=…;timestamp=…;nonce=…;signature=…` header. The
signature is computed as:

```
authData    = "EG1-HMAC-SHA256 client_token=…;access_token=…;timestamp=…;nonce=…;"
signingKey  = base64( HMAC-SHA256(client_secret, timestamp) )
dataToSign  = method \t scheme \t host \t path?query \t <signed-headers> \t <content-hash> \t authData
signature   = base64( HMAC-SHA256(signingKey, dataToSign) )
Authorization = authData + "signature=" + signature
```

- `timestamp` format is `yyyyMMddTHH:mm:ss+0000` (UTC, within ~30s of real time).
- `<content-hash>` = `base64(SHA256(body))` **only for POST** (PUT/DELETE bodies
  are never hashed — an EdgeGrid quirk); the body is truncated to 128 KB first.
- `<signed-headers>` is empty for the Network Lists API.
- The signing key is the **base64 string**, used directly as the HMAC key for the
  final signature.

The signer is isolated in [`lib/akamaiApi.ts`](lib/akamaiApi.ts) and unit-tested
in [`lib/__tests__/akamaiApi.test.ts`](lib/__tests__/akamaiApi.test.ts).

## Endpoints (Network Lists API v2)

Base URL: `https://<host>`

| Operation | Method + path |
| --- | --- |
| List | `GET /network-list/v2/network-lists` (query: `listType`, `includeElements`, `search`, `extended`) |
| Create | `POST /network-list/v2/network-lists` — `{ name, type, description, list }` |
| Get one | `GET /network-list/v2/network-lists/{networkListId}` |
| Update (full replace) | `PUT /network-list/v2/network-lists/{networkListId}` — `{ name, type, description, list, syncPoint }` |
| Append | `POST /network-list/v2/network-lists/{networkListId}/append` — `{ list: [...] }` |
| Delete | `DELETE /network-list/v2/network-lists/{networkListId}` (only never-activated lists) |

Connectivity check:
`GET /network-list/v2/network-lists?listType=IP&includeElements=false`.

`type` is `IP` (addresses / CIDR blocks) or `GEO` (ISO 3166 two-letter country
codes) and **cannot be changed** after a list is created. `syncPoint` is a version
counter that must match the list's latest value on `PUT` (the app re-reads it).

## Pages

- **Overview** — what the app manages (fed by the `/meta` route).
- **Setup Guide** — EdgeGrid credential → connection → author & deploy.
- **Connections** — wraps the SDK `ConnectionsManager`; saving a connection
  registers `akamai` as a deploy target and runs the connectivity test.

## Verify

```
npx tsc --noEmit                         # from apps/akamai
node scripts/validate-app.mjs apps/akamai
node scripts/test-apps.mjs akamai
```

## Sources

- EdgeGrid authentication — <https://techdocs.akamai.com/developer/docs/edgegrid>
  (algorithm cross-checked against the official `AkamaiOPEN-edgegrid-python` and
  `-ruby` reference signers).
- Network Lists API v2 — <https://techdocs.akamai.com/network-lists/reference/api>
