# 📡 Darktrace

Manage a [Darktrace](https://www.darktrace.com) NDR (Network Detection & Response)
deployment's **intel feed** as code on the Veltrix Security-as-Code platform. Author
watched domains / IPs / hostnames in the Configuration Canvas and drive them through
the pipeline (validate → deploy → rollback → health-check → drift-detect → status).

## An honest note on Darktrace's API

Darktrace's REST API is **read-heavy**. The bulk of it reports *out* of the platform
— model breaches, device summaries, AI Analyst incidents, connection details,
`/status`, `/summarystatistics`. Comparatively little is designed to be written as
configuration. The one clear, supported **writable** surface is the **intel feed**
(`/intelfeed`) — the watched-domain list that feeds Darktrace's detections and,
optionally, Antigena responses. So v0.1.0 manages exactly that, and does not pretend
the rest of the API is configuration-as-code.

## How it's managed

Darktrace exposes its REST API over HTTPS (443), authenticated with the **DSA**
("Darktrace Signed API") scheme — a **two-token** pair:

- **Public token** — sent in the clear as the `DTAPI-Token` header. Stored as the
  connection credential's **username**.
- **Private token** — the HMAC secret, never sent. Stored as the connection
  credential's **secret** (API token).

Every request carries three headers:

| Header | Value |
|---|---|
| `DTAPI-Token` | the public token |
| `DTAPI-Date` | a UTC timestamp, compact form `YYYYMMDDTHHMMSS` (e.g. `20250115T143022`) |
| `DTAPI-Signature` | `HMAC-SHA1( privateToken, "<request-uri incl. sorted query>\n<publicToken>\n<date>" )`, hex |

Query parameters are sorted alphabetically in **both** the signed string and the wire
request. Darktrace appliances commonly present a **self-signed certificate**, which
the transport tolerates. The signing assembly is isolated in `lib/darktraceApi.ts`
and pinned by unit tests (`lib/__tests__/darktraceApi.test.ts`).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Watched Domains** | Darktrace REST API (`GET/POST /intelfeed`) | ✅ v0.1.0 |

Each item is one watched entry: a domain / IP / hostname, its watched-list **source**,
an optional **description** and **expiry**, and the **hostname** and **Antigena
(iagn)** flags. The entry name is the stable identity:

- **deploy** reads the live feed (`GET /intelfeed?fulldetails=true`) and adds only
  entries not already present (`POST /intelfeed` with `addentry`), recording exactly
  what it created — Darktrace's intel feed is append/remove only, so this is an
  idempotent upsert (no per-entry edit).
- **rollback** removes exactly the entries this deploy added (`POST /intelfeed` with
  `removeentry`).
- **drift-detect** flags any declared entry that has been removed upstream.
- **health-check / connectivity test** hit `GET /intelfeed?sources=true` — a
  lightweight, DSA-signed read that confirms reachability + a valid signature.

## Verify against a live Darktrace

The DSA details above are confirmed against multiple public Darktrace API clients but
should be re-verified against your appliance:

1. **HMAC algorithm is SHA1** (not SHA256). Some third-party write-ups say SHA256 —
   do not switch without a live check.
2. **`DTAPI-Date` is the compact basic form** `YYYYMMDDTHHMMSS`, not dashed/colon ISO.
3. **POST body vs. signature** — on the clients verified, the signature covers the
   request URI (path) and `/intelfeed` write parameters travel in the JSON body;
   confirm newer builds do not additionally sign the body.
4. **Intel-feed parameter names** (`addentry`, `addlist`, `source`, `description`,
   `expiry`, `hostname`, `iagn`, `removeentry`) and the accepted **expiry** format.

TLS verification is off by default (self-signed) and surfaced via the `verify_tls`
setting.

Apache-2.0.
