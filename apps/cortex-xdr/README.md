# Cortex XDR (Veltrix app)

Manage **Palo Alto Networks Cortex XDR** configuration as code through the Cortex
XDR **public REST API**. Authoring happens in the Veltrix Configuration Canvas;
every write goes through the Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

This is a **config-as-code only** app — it holds no database and provisions no
infrastructure. It writes only through the Cortex XDR API.

## What it manages

| Configuration type          | Cortex XDR endpoint                    | Identity (natural key) |
| --------------------------- | -------------------------------------- | ---------------------- |
| **Threat Indicators (IOCs)** | `/public_api/v1/indicators/insert_jsons/` | Indicator value        |

The IOCs type reconciles by the indicator VALUE: `insert_jsons` upserts by that
value, so a single bulk call reconciles every item. Rollback deletes anything this
deployment created and restores anything it updated (best-effort — see
Limitations).

> **Endpoint / field verification.** The exact indicator endpoint paths, request
> envelopes and field names are marked `VERIFY against live Cortex XDR` in the
> code (`lib/cortexXdrApi.ts`, `config-types/iocs/_shared.ts`). Confirm them
> against your tenant before relying on them in production.

## API & authentication

Cortex XDR exposes a **per-tenant** REST API. The tenant's API FQDN is the
connection endpoint / component hostname, e.g.
`api-yourtenant.xdr.us.paloaltonetworks.com`. Requests go to
`https://<fqdn>/public_api/v1/<path>`. Find the FQDN with **Copy URL** next to a
generated key under **Settings > Configurations > API Keys**.

- **Transport:** every call is a `POST` whose JSON body wraps its parameters in
  `request_data`, and every response wraps its payload in `reply`:
  - request: `{ "request_data": { ... } }`
  - response: `{ "reply": ... }`
  - A few bulk endpoints (notably `indicators/insert_jsons`) take `request_data`
    as an **array** of objects instead of an object — the client passes the exact
    body per call.
- **Auth (Standard security level):** two headers on every call —
  - `x-xdr-auth-id: <API Key ID>` (the integer key id)
  - `Authorization: <API Key>` (the key value, sent verbatim — no `Bearer`)
- **Advanced security** keys add a per-request nonce + timestamp + SHA256 HMAC
  signature. Only **Standard** is wired up in v0.1.0; the Advanced signing seam is
  stubbed and clearly commented in `lib/cortexXdrApi.ts` as a follow-up.
- **Bad credentials** surface as **HTTP 401 / 403**.

## Setup

1. **API key** — in the Cortex XDR console, **Settings > Configurations > API
   Keys**, create a key with the **Standard** security level and a role scoped to
   what this app manages.
2. **Credential** — store the key as a Veltrix credential: **username** → API Key
   ID, **API Key (token)** → the API Key value.
3. **Component** — register a **`cortex-xdr-tenant`** component whose hostname is
   your tenant API FQDN (Copy URL) and attach the credential. The Connections page
   does both when you save a connection.
4. **Connections** — use the app's Connections page to verify the tenant FQDN +
   key with a live probe (`POST /public_api/v1/endpoints/get_endpoint_groups/`).

## Configuration notes

- **Indicators (IOCs)** — the indicator VALUE is the identity used for upsert and
  drift. `type` is one of `HASH`, `IP`, `DOMAIN_NAME`, `PATH`, `FILENAME`;
  `severity` one of `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`; `reputation` one
  of `GOOD`, `BAD`, `SUSPICIOUS`, `UNKNOWN`; `reliability` an Admiralty grade
  `A`–`F`. `expiration_date` is an optional Unix epoch timestamp in
  **milliseconds** (leave blank for never). All enum values and the expiration
  units are `VERIFY`-flagged against a live tenant.

## Limitations

- **Standard auth only** in v0.1.0 (Advanced HMAC signing is a documented seam).
- **Rollback / drift reads are best-effort.** Cortex XDR has no simple "list all
  IOCs" endpoint; the app reads via `indicators/get_changes` and matches by
  indicator value. When a read is unavailable or an indicator can't be matched,
  drift is not asserted and a rollback snapshot may be empty (a created indicator
  still rolls back cleanly by deletion).
- Write-only secrets (the API Key) are never read back, diffed, or stored in
  rollback data / artifacts / logs.
- The app writes only through the Cortex XDR API; it registers no platform-side
  database tables or background jobs.

## Development

```
cd apps/cortex-xdr
node node_modules/typescript/bin/tsc --noEmit        # typecheck
node ../../scripts/test-apps.mjs cortex-xdr          # run the config-type tests
node ../../scripts/validate-app.mjs apps/cortex-xdr   # (from repo root) manifest + bundle checks
```
