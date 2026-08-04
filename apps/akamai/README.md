# Akamai (Veltrix app)

Manage **Akamai edge security, DNS and edge delivery as code**. Author Network
Lists, Client Lists, Edge DNS zones/records, Cloudlets policies and EdgeWorker
identities, and drive them through the Security-as-Code pipeline (validate →
deploy → health check → drift detect → rollback) over Akamai's OPEN APIs,
authenticated with **EdgeGrid (EG1-HMAC-SHA256)** request signing.

- **Category:** NETWORK
- **Version:** 0.3.0
- **Component type:** `akamai`

## What it manages

| Configuration type | Group | What it does |
| --- | --- | --- |
| **Network Lists** | Edge Security | Create / update / delete a named `IP` or `GEO` list and sync its elements (upsert by list name). |
| **Network List Activation** | Edge Security | Activate a Network List onto STAGING / PRODUCTION (forward-only — see Coverage below). |
| **Client Lists** | Edge Security | Create / update / delete a typed list (IP/GEO/ASN/TLS fingerprint/file hash/user ID/domain/header) and sync its entries. |
| **DNS Zones** | Edge DNS | Create / update a PRIMARY / SECONDARY / ALIAS Edge DNS zone. |
| **DNS Records** | Edge DNS | Create / update / delete an individual recordset (name, type, TTL, raw rdata) inside a zone. |
| **Cloudlets Policies** | Cloudlets | Create / update / delete a Cloudlets shared policy and its match-rule versions. |
| **Cloudlets Policy Activation** | Cloudlets | Activate / deactivate a policy version onto STAGING / PRODUCTION (real rollback — see Coverage below). |
| **EdgeWorkers** | EdgeWorkers | Create / update / delete an EdgeWorker identity (name, group, resource tier). Code bundles ship via CI/CD — see Coverage below. |
| **EdgeWorker Activation** | EdgeWorkers | Activate an existing code-bundle version onto STAGING / PRODUCTION (real rollback — see Coverage below). |

See [Coverage](#coverage-v030) below for full endpoint-level detail and what
was intentionally left out.

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

## Coverage (v0.3.0)

Coverage was audited against the Akamai OPEN API index (techdocs.akamai.com)
and cross-checked against the official Go SDK
(`github.com/akamai/AkamaiOPEN-edgegrid-golang` — the same client the Akamai
Terraform provider is built on) for endpoints whose interactive HTML reference
is login-gated.

### Managed declarative configuration

| Configuration type | API operations |
| --- | --- |
| Network Lists | `GET`/`POST`/`PUT`/`DELETE /network-list/v2/network-lists[/{id}]` |
| Network List Activation | `POST /network-list/v2/network-lists/{id}/environments/{env}/activate`, `GET .../status` |
| Client Lists | `GET`/`POST`/`PUT /client-list/v1/lists[/{id}]`, `POST .../{id}/items` |
| DNS Zones | `GET`/`POST`/`PUT /config-dns/v2/zones[/{zone}]` |
| DNS Records | `GET`/`POST`/`PUT`/`DELETE /config-dns/v2/zones/{zone}/names/{name}/types/{type}` |
| Cloudlets Policies | `GET`/`POST`/`PUT`/`DELETE /cloudlets/v3/policies[/{id}]`, `GET`/`POST /cloudlets/v3/policies/{id}/versions` |
| Cloudlets Policy Activation | `POST /cloudlets/v3/policies/{id}/activations` (`ACTIVATION` / `DEACTIVATION`) |
| EdgeWorkers | `GET`/`POST`/`PUT`/`DELETE /edgeworkers/v1/ids[/{edgeWorkerId}]` |
| EdgeWorker Activation | `POST /edgeworkers/v1/ids/{id}/activations`, `POST .../deactivations` |

**Rollback honesty varies by API, not by choice.** Network List Activation's
public API has no deactivate endpoint at all, so its rollback is a documented,
forward-only no-op. Cloudlets and EdgeWorkers activation both expose a real
deactivation operation, so their rollbacks **genuinely** undo a promotion
(re-activate the prior version, or deactivate outright). Zone deletion is
async (`POST /config-dns/v2/zones/delete-requests`) so rollback of a created
zone *requests* deletion rather than confirming it; per-record deletion is
synchronous, so DNS Records rollback is a confirmed delete, same as Network
Lists / Client Lists.

### Intentionally excluded

- **PAPI (property rule-trees)** — the core delivery-configuration surface is
  a single deeply nested rule tree with its own versioned-config +
  staging/production activation lifecycle; too large/complex for a clean
  declarative surface (the same bar EdgeWorkers/Cloudlets/DNS were held to and
  passed).
- **CPS (certificate provisioning) enrollments** — even non-secret enrollment
  fields are inseparable from an async, multi-step domain-validation /
  issuance lifecycle. Evaluated in v0.3.0 and dropped.
- **App & API Protector / Application Security configurations (WAF)** — rate
  policies, match targets, custom rules and firewall rules live inside a
  versioned security configuration with its own activation lifecycle.
  Evaluated in v0.2.0 and again in v0.3.0; dropped both times.
- **Bot Manager** — configured as part of an Application Security
  configuration version, inheriting the same complexity as WAF above.
- **SIEM** — a read-only security-event log retrieval/streaming API, not a
  config-as-code write surface at all.
- **IAM (users / groups / roles)** — verified as clean CRUD but deliberately
  excluded: account-wide identity/access administration is security-sensitive
  control-plane bootstrap, not edge-security/edge-delivery configuration — the
  same boundary Cisco Meraki draws around organization administrators in this
  monorepo.
- **EdgeWorker code bundles** — a gzipped tarball (`bundle.json` + `main.js`)
  uploaded as binary content, with no clean text/JSON canvas representation;
  ships via CI/CD or the Akamai CLI instead. Only the EdgeWorker's identity
  (name/group/tier) and version *activation* are managed here.

Primary references: the endpoint-specific techdocs.akamai.com reference pages
linked from each config type's `_shared.ts`, and
[`AkamaiOPEN-edgegrid-golang`](https://github.com/akamai/AkamaiOPEN-edgegrid-golang)
`pkg/dns`, `pkg/cloudlets/v3` and `pkg/edgeworkers`.

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
- Client Lists API v1 — <https://techdocs.akamai.com/client-lists/reference/api>
- Edge DNS API v2 — <https://techdocs.akamai.com/edge-dns/reference/edge-dns-api>
- Cloudlets API v3 — <https://techdocs.akamai.com/cloudlets/reference/api>
- EdgeWorkers API v1 — <https://techdocs.akamai.com/edgeworkers/reference/api>
- Identity and Access Management API v3 (evaluated, not implemented — see
  Coverage) — <https://techdocs.akamai.com/iam-api/reference/api>
- Official Go SDK (endpoint/field provenance for login-gated references) —
  <https://github.com/akamai/AkamaiOPEN-edgegrid-golang>
