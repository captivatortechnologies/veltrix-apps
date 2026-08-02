# HackerOne

Manage HackerOne program **asset scope** as code. This app authors a program's
**Structured Scopes** — the assets that are in scope for its bug-bounty /
vulnerability-disclosure program — and drives them through the Veltrix
Security-as-Code pipeline (validate, deploy, health check, drift detection and
rollback).

- **Category:** COMPLIANCE
- **API:** `https://api.hackerone.com/v1` (fixed host), JSON:API
- **Auth:** HTTP Basic — `Authorization: Basic base64(<API username>:<API token>)`
- **No BYOL / no database** — HackerOne is a pure SaaS API.

## What it manages

### Structured Scopes (`structured-scopes`)

One item = one asset in a program's scope. Fields:

| Field | Notes |
| --- | --- |
| `program_handle` | The HackerOne program handle (`hackerone.com/<handle>`). Resolved to a program id via `GET /me/programs`. |
| `asset_identifier` | The asset value (e.g. `api.example.com`, `*.example.com`, `10.0.0.0/24`, a store app id). The scope's stable identity for upsert + drift **within the program**. |
| `asset_type` | `URL`, `CIDR`, `DOMAIN`, `WILDCARD`, `GOOGLE_PLAY_APP_ID`, `OTHER_APK`, `APPLE_STORE_APP_ID`, `TESTFLIGHT`, `OTHER_IPA`, `WINDOWS_APP_STORE_APP_ID`, `SOURCE_CODE`, `DOWNLOADABLE_EXECUTABLES`, `HARDWARE`, `AI_MODEL`, `SMART_CONTRACT`, `OTHER`. |
| `eligible_for_submission` | Whether researchers may submit against the asset (default on). |
| `eligible_for_bounty` | Whether valid reports are bounty-eligible (default off). |
| `max_severity` | `none` / `low` / `medium` / `high` / `critical`. |
| `instruction` | Optional tester guidance shown on the scope page. |

Scopes are grouped by `program_handle`, each handle resolved to its program id,
and each asset **upserted by identifier** within that program:

```
GET  /me/programs                              # handle → id
GET  /programs/{id}/structured_scopes          # existing scopes (JSON:API, paginated)
POST /programs/{id}/structured_scopes          # create  { data: { type: "structured-scope", attributes } }
PUT  /programs/{id}/structured_scopes/{sid}    # update  { data: { type: "structured-scope", attributes } }
```

`rollback` restores the prior attributes of a scope it updated, or archives a
scope it created.

## Connecting

1. In HackerOne, create an **API token** (Organization Settings → API Tokens).
   HackerOne shows an **identifier** (the token name) and a **token value**.
2. On the app's **Connections** page, store the identifier in **API username** and
   the token value in **API token**. The API host is fixed at `api.hackerone.com`.
3. **Test** the connection — it calls `GET /me/programs`.
4. Author scopes in the **Configuration Canvas** and deploy through the pipeline.

## Flagged — verify against live HackerOne

- **Write endpoints:** HackerOne removed the program-level **create / update /
  archive** structured-scope endpoints from its public docs on **2026-04-07**
  (assets are now managed via *organization asset-management* endpoints). The
  `GET` (list) endpoint remains documented. The write path used here (the
  historical `POST` / `PUT /programs/{id}/structured_scopes[/{id}]` with a
  `{ data: { type, attributes } }` body) — and whether it should move to the
  organization asset-management endpoints — must be verified against the live API.
- **`asset_type` enum:** the exact machine value set has varied across API
  revisions — verify the canvas select values if a type is rejected.
- **Archive semantics:** rollback archives a created scope via
  `PUT { archived: true }`; confirm whether the live API expects that or a
  `DELETE`.

## References

- Getting started / auth: https://api.hackerone.com/getting-started/
- Customer API reference (Structured Scopes, Programs): https://api.hackerone.com/customer-resources/
- Asset types: https://docs.hackerone.com/en/articles/8486276-asset-types
