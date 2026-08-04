# Vectra AI

Manage **Vectra AI** (Network Detection & Response, NDR) configuration **as code**.
Author configurations in the Configuration Canvas and drive them through the
Veltrix Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback — over the **Vectra Detect REST API**.

- **Category:** NETWORK
- **Manages:** Triage Rules, Groups, Proxies, Internal Networks, Vectra Match
  sensor enablement + ruleset assignment, Assignment Outcomes, Entity Tags
- **Transport:** HTTPS 443, self-signed certificate tolerated (on-prem Vectra
  brains commonly ship one; enforce a valid cert with the `verify_tls` setting)

## API

This app targets the **Vectra Detect API v2.5** (the version that exposes triage
rule CRUD, and — via the same token-authenticated transport — Vectra Match).

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

### Groups endpoints (`/api/v2.5/groups`)

| Operation | Method & path |
| --------- | ------------- |
| List      | `GET /groups` (DRF envelope `{ count, results: [...] }`) |
| Get       | `GET /groups/{id}` |
| Create    | `POST /groups` — body `{ name, description, type, members }` |
| Update    | `PATCH /groups/{id}` — body `{ name, description, members }` (`type` is immutable after create) |
| Delete    | `DELETE /groups/{id}` |

`type` is one of `host` / `domain` / `ip` / `account` — **all four are confirmed**
against the operative v2.5 client (see Coverage below). Only static `members` are
managed (dynamic regex membership is out of scope). The **group `name`** is the
stable identity for upsert and drift matching.

### Proxies endpoints (`/api/v2.5/proxies`)

| Operation | Method & path |
| --------- | ------------- |
| List      | `GET /proxies` |
| Get       | `GET /proxies/{id}` |
| Create    | `POST /proxies` — body `{ proxy: { address, considerProxy } }` |
| Update    | `PATCH /proxies/{id}` — body `{ proxy: { address?, considerProxy? } }` |
| Delete    | `DELETE /proxies/{id}` |

The **proxy `address`** is the stable identity for upsert and drift matching.

> **Known vendor bug (APP-15864):** Vectra's own Python client carries an open
> caution on `update_proxy` — a `PATCH` update can change the proxy's resource
> id as a side effect, and an invalid id then surfaces as an HTTP 500 instead of
> a 404. `rollback.ts` re-resolves a proxy's current id by its address before
> restoring it rather than trusting the id captured at deploy time.

### Internal Networks (`/api/v2.5/settings/internal_network`)

| Operation | Method & path |
| --------- | ------------- |
| Read      | `GET /settings/internal_network` → `{ included_subnets, excluded_subnets, dropped_subnets }` |
| Write     | `POST /settings/internal_network` — body `{ include, exclude, drop }` (**full replace**) |

A brain-wide **singleton** — one canvas item declares the complete desired set of
internal / excluded / dropped subnets. **Flagged:** the read and write bodies use
different key names for the same three lists.

### Vectra Match — Enablement (`/api/v2.5/vectra-match/enablement`)

| Operation | Method & path |
| --------- | ------------- |
| Read      | `GET /vectra-match/enablement?device_serial={serial}` |
| Write     | `POST /vectra-match/enablement` — body `{ device_serial, desired_state }` |

Enables/disables Vectra Match (Suricata-based Suspect Protocol Activity
detections, added in Detect v2.5) on one sensor device. Requires a valid **Vectra
Match license**. A boolean toggle, not a create/delete resource lifecycle.

### Vectra Match — Ruleset Assignment (`/api/v2.5/vectra-match/assignment`)

| Operation | Method & path |
| --------- | ------------- |
| List      | `GET /vectra-match/assignment` (every live `(uuid, device_serial)` mapping — no filter) |
| Assign    | `POST /vectra-match/assignment` — body `{ uuid, device_serials: [...] }` (adds; bulk per uuid) |
| Unassign  | `DELETE /vectra-match/assignment` — body `{ uuid, device_serial }` (removes one device) |

Assigns an **already-uploaded** Vectra Match custom ruleset (by UUID) to sensor
devices, reconciled as a set. Ruleset **content** is managed outside this config
type — see Coverage below.

### Assignment Outcomes (`/api/v2.5/assignment_outcomes`)

| Operation | Method & path |
| --------- | ------------- |
| List      | `GET /assignment_outcomes` |
| Get       | `GET /assignment_outcomes/{id}` |
| Create    | `POST /assignment_outcomes` — body `{ title, category }` |
| Update    | `PUT /assignment_outcomes/{id}` — body `{ title, category }` |
| Delete    | `DELETE /assignment_outcomes/{id}` |

`category` is one of `benign_true_positive` / `malicious_true_positive` /
`false_positive`. The **outcome `title`** is the stable identity for upsert and
drift matching. Added in API v2.2+.

### Entity Tags (`/api/v2.5/tagging/{host|account}/{id}`)

| Operation | Method & path |
| --------- | ------------- |
| Read      | `GET /tagging/{host|account}/{id}` → `{ tags: [...] }` |
| Write     | `PATCH /tagging/{host|account}/{id}` — body `{ tags: [...] }` (**full replace**) |

Manages the tag set on one host or account, identified by its numeric Vectra
entity id (the same kind of id Groups' host-type membership already declares
directly). One config type covers both entity types via an `entity_type` field.
Detection tags are intentionally not managed — see Coverage below.

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
3. **Author & deploy** — in the **Configuration Canvas**, pick a configuration
   type, author it, and deploy through the pipeline.

## Pipeline

Every configuration type shares the same lifecycle:

- **validate** — static checks (identity, enum values, required fields, scope).
- **deploy** — upsert by the type's stable identity (or a full-replace singleton
  for Internal Networks; a set-reconciliation for Match Ruleset Assignment).
  Records rollback data (prior state, or what a reconciliation added/removed).
- **rollback** — restores the prior state, deletes what a deploy created (where
  the API supports delete), or inverts a reconciliation's adds/removes.
- **healthCheck** — a lightweight, type-appropriate reachability + auth probe.
- **driftDetect** — compares declared vs. live state; best-effort (a resource
  that can't be read is skipped, not falsely flagged as drifted).
- **getStatus** — deployment status from platform records.

## Verify against a live Vectra

The following are modeled from Vectra's official API docs and its published Python
client (`vectra_api_tools`, all client versions through `VectraClientV2_5`), but
should be confirmed against a live Vectra brain:

- Exact `detection_category` enum **values and casing** (only `LATERAL MOVEMENT`
  is confirmed from the docs) and valid `detection` (detection type) names.
- The create/update response envelope shapes (bare object vs. wrapped, e.g.
  `{ group: {...} }`) — handled defensively throughout.
- Internal Networks' GET/POST key-name asymmetry (`included_subnets` vs `include`,
  etc.).
- Vectra Match's enablement GET response field name (`desired_state` / `state` /
  `enabled` are all tolerated) and the assignment list envelope shape.

## Coverage (v0.3.0)

Coverage was audited against Vectra's official Python client
(`vectra_api_tools`, `modules/vectra.py`, the full class chain through
`VectraClientV2_5`) on 2026-08-04, cross-referenced with Vectra's official API
docs (`docs.vectra.ai`).

### Managed declarative configuration

| Configuration type | Detect API operations |
| --- | --- |
| Triage rules | list/create/update/delete `/rules` |
| Groups | list/create/update/delete `/groups` (host / domain / ip / account) |
| Proxies | list/create/update/delete `/proxies` |
| Internal networks | `GET` / `POST /settings/internal_network` (full-replace singleton) |
| Match enablement | `GET` / `POST /vectra-match/enablement` (per sensor) |
| Match ruleset assignment | `GET` / `POST` / `DELETE /vectra-match/assignment` (set-reconciled) |
| Assignment outcomes | list/create/update/delete `/assignment_outcomes` |
| Entity tags | `GET` / `PATCH /tagging/{host\|account}/{id}` (full replace) |

### Intentionally excluded

- **`threatFeeds`** — `create_feed` (`POST`) / `delete_feed` (`DELETE`) /
  `post_stix_file` (multipart) exist; there is still no update/PATCH method at
  any client version, so a feed can't be cleanly upserted or rolled back
  in-place.
- **`users`** — `update_user` (`PATCH`, `account_type` +
  `authentication_profile` only) is the only write method; there is still no
  `create_user`, so a user can't be declared/created through this API.
- **AWS External Connector** (`POST /settings/aws_connectors`) — create-only
  (no update, no delete) and embeds a raw AWS secret access key in the request
  body. Not cleanly upsertable/rollback-able, and security-sensitive
  control-plane bootstrap (parallel to credential/API-key administration
  excluded from other apps in this catalog).
- **Sensor registration token** (`/sensor_token`) — a single, 24h-lived
  bootstrap secret, not a durable declared resource.
- **Vectra Match custom ruleset content** (`POST`/`DELETE /vectra-match/rules`,
  multipart file upload) — no update-in-place, and no "list all rulesets"
  capability exists in the official client to safely detect an existing
  ruleset by identity before creating (only a uuid-scoped lookup, which
  requires already knowing the uuid). Upserting would risk creating duplicate
  rulesets on every deploy. Upload/manage ruleset content through the Vectra UI
  or Vectra's own `vectra_match_workflow` tooling; this app manages the
  adjacent, fully enumerable device enablement and device↔ruleset assignment.
- **Assignment lifecycle** (`create_account_assignment` /
  `create_host_assignment` / `update_assignment` / `delete_assignment` /
  `set_assignment_resolved`) — per-detection analyst work assignment and
  resolution is operational incident-response workflow state, not durable
  infrastructure-as-code. The small, static resolution-label **catalog** that
  workflow references (`assignment_outcomes`) is managed instead.
- **Host / account / detection notes** (`PATCH` on the host/account object) —
  free-text incident annotation, not stable declarative desired state worth
  drift-correcting back to a canvas value. Tags (a stable classification
  concern) are managed instead.
- **Roles** — no distinct Roles CRUD resource exists in the Detect API;
  `update_user`'s `account_type`/`authentication_profile` is the only
  identity-adjacent write, already excluded above.
- **Detection tags** (`/tagging/detection/{id}`) — a detection is a single,
  short-lived event instance, not a durable entity worth declaring desired
  state for. Only host and account tags are managed.
- Read-only monitoring/reporting endpoints (detections, hosts, accounts,
  campaigns, traffic/subnet stats, health checks, audits) are out of scope —
  they have no declarative write surface.

Drop-don't-fake: nothing here is stubbed or faked as "supported."

## Sources

- Vectra AI Docs — Creating triage filters via API:
  https://docs.vectra.ai/configuration/tuning/creating-triage-filters-via-api
- Vectra AI Docs — v2.5 API guide (QUX):
  https://docs.vectra.ai/configuration/access/api-qux/v25-api-guide-qux
- Vectra AI Docs — v2.5 Postman quick start (token auth):
  https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-token-auth
- Vectra AI Docs — v2.5 Postman quick start (OAuth2):
  https://docs.vectra.ai/configuration/access/api-qux/v25-postman-quick-start-guide-using-oauth2
- Vectra AI Docs — Vectra Match deployment & FAQ:
  https://docs.vectra.ai/deployment/match/deployment ,
  https://docs.vectra.ai/deployment/match/faq
- Vectra published Python client (`vectra_api_tools`):
  https://github.com/vectranetworks/vectra_api_tools
  (`modules/vectra.py` — the ground truth for every endpoint in this app,
  including the `VectraClientV2_4`/`VectraClientV2_5` method-resolution facts
  behind the Groups `account`-type confirmation and the proxies APP-15864 note)
- Vectra Match automation reference: https://github.com/vectranetworks/vectra_match_workflow
