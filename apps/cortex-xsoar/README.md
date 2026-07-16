# Cortex XSOAR — Veltrix App

Manage Palo Alto Networks **Cortex XSOAR** content configuration as code through the
XSOAR server REST API. Authoring happens in the Veltrix Configuration Canvas; every
write goes through the Security-as-Code pipeline (validate → deploy → health check →
drift detect → rollback).

## What it manages

| Configuration type | XSOAR endpoints | Identity |
| --- | --- | --- |
| **Lists** | `GET /lists`, `POST /lists/save`, `POST /lists/delete` | list name (a list's id equals its name) |
| **Incident Types** | `GET /incidenttype`, `POST /incidenttype`, `POST /incidenttype/delete` | type name |
| **Jobs** (scheduled / time-triggered) | `POST /jobs/search`, `POST /jobs`, `DELETE /jobs/{id}` | job name |

Each type reconciles by **name**: the deploy lists the live objects, matches on name,
then creates or updates. Rollback deletes objects it created and restores objects it
updated to their captured prior state. Built-in / locked objects (system incident
types such as *Unclassified*, locked lists) are never modified.

## Authentication

Cortex XSOAR authenticates with an **API key** created under
**Settings → Integrations → API Keys**. The key is sent in the `Authorization`
header (the raw key value — XSOAR does not use a `Bearer`/`ApiToken` prefix).

- **Cortex XSOAR 6.x (on-prem server):** base URL is the server FQDN
  (`https://<fqdn>`); only the `Authorization` header is sent.
- **Cortex XSOAR 8 / the Cortex platform:** the same `Authorization` header **plus**
  `x-xdr-auth-id: <api-key-id>`, routed through the Cortex API gateway host under the
  `/xsoar` base path.

Setting the **API Key ID** (`auth_id`) app setting is what selects XSOAR-8 mode.

## Setup

1. **API key** — create an API key in Cortex XSOAR and copy it. For XSOAR 8, also copy
   the key's numeric **API Key ID**.
2. **Credential** — store the API key in a Veltrix credential's **API token** field.
3. **Component** — register an **`xsoar-server`** component whose hostname is the XSOAR
   server FQDN (XSOAR 6.x) or the Cortex API gateway host (XSOAR 8), and attach the
   credential.
4. **Settings** (optional):
   - `auth_id` — the XSOAR 8 API Key ID (enables `x-xdr-auth-id` + `/xsoar` base path).
   - `api_base_path` — override the REST base path (default: auto).
   - `request_timeout_seconds` — per-request timeout (default 30).

Use the **Connections** page to verify a server URL + API key with a single
authenticated `GET /user` probe.

## Scope & honesty

These three types were chosen because their full create / read / delete REST contract
is confirmed against the XSOAR server API (as used by `demisto-sdk` and the XSOAR
ContentManagement pack). Objects whose REST write path is not cleanly documented
(e.g. pre-processing rules, which expose a stable `GET /preprocess/rules` and
`DELETE /preprocess/rule/{id}` but no clearly documented save endpoint) are
intentionally left out rather than shipped as an unreliable write. Write-only secrets
(the API key) are never read back, diffed or stored by the handlers.
