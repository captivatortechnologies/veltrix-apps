# Vectra AI

Manage **Vectra AI** (Network Detection & Response, NDR) configuration **as code**.
Author **triage rules** in the Configuration Canvas and drive them through the
Veltrix Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback — over the **Vectra Detect REST API**.

- **Category:** NETWORK
- **Manages:** Triage Rules (detection tuning)
- **Transport:** HTTPS 443, self-signed certificate tolerated (on-prem Vectra
  brains commonly ship one; enforce a valid cert with the `verify_tls` setting)

## API

This app targets the **Vectra Detect API v2.5** (the version that exposes triage
rule CRUD).

- **Base URL:** `https://<vectra-brain-host>/api/v2.5/`
  (e.g. `https://mytenant.vectra.ai/api/v2.5/`)
- **Authentication:** an API token sent verbatim in the header —
  `Authorization: Token <api-token>` (a literal `Token ` prefix, **not** Bearer).
  Create it under **My Profile → API Token** in the Vectra UI. Only **local**
  accounts can mint tokens, and a token inherits its account's permissions.

### Triage Rules endpoints (`/api/v2.5/rules`)

| Operation | Method & path |
| --------- | ------------- |
| List      | `GET /rules` (DRF paging: `page`, `page_size`, `ordering`, `contains`; returns `{ count, results: [...] }`) |
| Get       | `GET /rules/{id}` |
| Create    | `POST /rules` |
| Update    | `PUT /rules/{id}` |
| Delete    | `DELETE /rules/{id}?restore_detections=true` |

A rule body carries: `description`, `detection_category`, `detection` (detection
type name), `triage_category`, `is_whitelist`, `all_hosts`, `host` (host IDs),
`ip`, `remote1_ip`, `remote1_proto`, `priority`. The **rule `description`** is used
as the stable identity for upsert and drift matching (Vectra rules have no unique
name — keep descriptions unique per instance).

### Alternate: Vectra platform v3 (not implemented here)

The newer Vectra platform APIs (RUX / Respond, `/api/v3/`) authenticate with
**OAuth2 client-credentials**: `POST https://<host>/oauth2/token` with the Client
ID/Secret (HTTP Basic) and `grant_type=client_credentials` returns a **Bearer**
`access_token` (≈3600s TTL). A future app version can add a v3 path; the API token
(v2.5) path is the confirmed foundation.

## Setup

1. **API token** — in Vectra, sign in with a local account, open **My Profile**
   and create an **API Token**.
2. **Connection** — on the **Connections** page, add a connection to your Vectra
   brain host and attach the token, then **Test** it.
3. **Author & deploy** — in the **Configuration Canvas**, pick **Triage Rules**,
   author your rules, and deploy through the pipeline.

## Pipeline (Triage Rules)

- **validate** — static checks (identity, known detection category, required
  detection type, triage category vs. whitelist, scope, IP/CIDR shape).
- **deploy** — upsert by rule `description`: `PUT /rules/{id}` when it exists,
  else `POST /rules`. Records per-rule rollback data (prior body + id).
- **rollback** — restore the prior rule body, or delete a rule this deploy
  created (`restore_detections=true`).
- **healthCheck** — `GET /rules?page_size=1` reachability + auth probe.
- **driftDetect** — compares `triage_category`, `is_whitelist`,
  `detection_category` and `detection` against the live rule.
- **getStatus** — deployment status from platform records.

## Verify against a live Vectra

The following are modeled from Vectra's official API docs and its published Python
client, but should be confirmed against a live Vectra brain:

- Exact `detection_category` enum **values and casing** (only `LATERAL MOVEMENT`
  is confirmed from the docs) and valid `detection` (detection type) names.
- The create/update response envelope (bare rule object vs. `{ rule: {...} }`) —
  both are handled defensively.

## Sources

- Vectra AI Docs — Creating triage filters via API:
  https://docs.vectra.ai/configuration/tuning/creating-triage-filters-via-api
- Vectra AI Docs — v2.5 API guide (QUX):
  https://docs.vectra.ai/configuration/access/api-qux/v25-api-guide-qux
- Vectra AI Docs — v2.5 Postman quick start (token auth):
  https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-token-auth
- Vectra AI Docs — v2.5 Postman quick start (OAuth2):
  https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-oauth2
- Vectra published Python client (`vectra_api_tools`):
  https://github.com/vectranetworks/vectra_api_tools
