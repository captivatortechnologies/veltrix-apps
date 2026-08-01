# 🛡️ Trend Micro Vision One

Manage [Trend Micro Vision One](https://www.trendmicro.com/en_us/business/products/detection-response.html)
threat intelligence as code on the Veltrix Security-as-Code platform. Author the
user-defined **Suspicious Object List** in the Configuration Canvas and drive it
through the pipeline (validate → deploy → rollback → health-check → drift-detect →
status).

## How it's managed

Trend Vision One exposes a regional **public REST API (v3.0)** over HTTPS. This app
applies configuration over that API:

- **HTTPS REST** — suspicious objects via `/v3.0/threatintel/suspiciousObjects`.
  Authentication is a Trend Vision One **API key** carried as a **Bearer token**
  (`Authorization: Bearer <token>`), generated in the console under
  **Administration → API Keys** and stored as the connection credential's token.
- **Regional host** — the connection endpoint / component hostname is your regional
  API host. Pick the one matching your Vision One console region:

  | Region | API host |
  |---|---|
  | United States | `api.xdr.trendmicro.com` |
  | Europe | `api.eu.xdr.trendmicro.com` |
  | Singapore | `api.sg.xdr.trendmicro.com` |
  | India | `api.in.xdr.trendmicro.com` |
  | Australia | `api.au.xdr.trendmicro.com` |
  | US Government | `api.usgov.xdr.trendmicro.com` |

  VERIFY the exact host for your tenant against your live Vision One console.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Suspicious Objects** | Vision One REST API (`/v3.0/threatintel/suspiciousObjects`) | ✅ v0.1.0 |

A suspicious object is a **type** (`domain`, `ip`, `url`, `fileSha1`,
`senderMailAddress`), a **value**, a **scan action** (`block` actively blocks the
object across connected Vision One products; `log` detects and records matches
without blocking), a **risk level** (`high` / `medium` / `low`), an optional
**description**, and an optional **days to expiration**.

The object value is the stable identity used to upsert (add updates an existing
object) and to detect drift; deploy snapshots the prior object body so rollback can
restore it (or remove an object it created).

## API endpoints

| Operation | Method + path | Body |
|---|---|---|
| List | `GET /v3.0/threatintel/suspiciousObjects` | — (returns `{ items, nextLink }`) |
| Add / update | `POST /v3.0/threatintel/suspiciousObjects` | `[{ <type>: value, description, scanAction, riskLevel, daysToExpiration }]` |
| Remove | `POST /v3.0/threatintel/suspiciousObjects/delete` | `[{ <type>: value }]` — **FLAGGED, verify** |

The identifier is keyed by the object type — e.g. a domain is sent as
`{ "domain": "evil.example.com", ... }`, a URL as `{ "url": "…", ... }`.

## Notes

The add + list paths and the Bearer auth scheme are confirmed from the Trend Vision
One Automation Center documentation. The **remove** path
(`/v3.0/threatintel/suspiciousObjects/delete`), the exact list-response envelope and
the `daysToExpiration` units are inferred from v3.0 conventions and should be
**verified against a live Vision One tenant**. The v3.0 API also supports a
`fileSha256` object type, which can be added alongside the five shipped here.

Apache-2.0.
