# 🛡️ Trend Micro Vision One

Manage [Trend Micro Vision One](https://www.trendmicro.com/en_us/business/products/detection-response.html)
threat intelligence, identity and response configuration as code on the Veltrix
Security-as-Code platform. Author the user-defined **Suspicious Object List**, its
**Exception List**, the Response Management **Custom Scripts** library, IAM **User
Accounts** and Cloud Risk Management **Custom Compliance Rules** in the
Configuration Canvas and drive them through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status).

## How it's managed

Trend Vision One exposes a regional **public REST API** over HTTPS — most of it
under a `v3.0` prefix, with Cloud Risk Management custom rules currently under a
`beta` prefix. This app applies configuration over that API:

- **HTTPS REST** — e.g. suspicious objects via
  `/v3.0/threatintel/suspiciousObjects`, user accounts via `/v3.0/iam/accounts`,
  custom compliance rules via `/beta/cloudPosture/customRules`. Authentication is
  a Trend Vision One **API key** carried as a **Bearer token**
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
| **Exception List** | Vision One REST API (`/v3.0/threatintel/suspiciousObjectExceptions`) | ✅ v0.2.0 |
| **Custom Scripts** | Vision One REST API (`/v3.0/response/customScripts`, multipart) | ✅ v0.2.0 |
| **User Accounts** | Vision One REST API (`/v3.0/iam/accounts`) | ✅ v0.3.0 |
| **Custom Compliance Rules** | Vision One REST API (`/beta/cloudPosture/customRules`) | ✅ v0.3.0 |

A suspicious object is a **type** (`domain`, `ip`, `url`, `fileSha1`,
`senderMailAddress`), a **value**, a **scan action** (`block` actively blocks the
object across connected Vision One products; `log` detects and records matches
without blocking), a **risk level** (`high` / `medium` / `low`), an optional
**description**, and an optional **days to expiration**.

The object value is the stable identity used to upsert (add updates an existing
object) and to detect drift; deploy snapshots the prior object body so rollback can
restore it (or remove an object it created).

A user account is an **email** (its identity), an **auth type** (`local` / `saml` /
`samlGroup`, used on invite only), a **role** and an optional **status**
(`enabled` / `disabled`) and **description**.

A custom compliance rule is a **name** (its identity), a **description**, one or
more **categories**, a **risk level**, a **cloud provider**, a **service** +
**resource type**, an **enabled** flag, and the rule's logic as two JSON arrays —
**attributes** to extract from a matched resource and **event rules** — the
pass/fail conditions evaluated over them.

## API endpoints

| Operation | Method + path | Body |
|---|---|---|
| List suspicious objects | `GET /v3.0/threatintel/suspiciousObjects` | — (returns `{ items, nextLink }`) |
| Add / update suspicious objects | `POST /v3.0/threatintel/suspiciousObjects` | `[{ <type>: value, description, scanAction, riskLevel, daysToExpiration }]` |
| Remove suspicious objects | `POST /v3.0/threatintel/suspiciousObjects/delete` | `[{ <type>: value }]` — **FLAGGED, verify** |
| List exceptions | `GET /v3.0/threatintel/suspiciousObjectExceptions` | — (returns `{ items, nextLink }`) |
| Add exceptions | `POST /v3.0/threatintel/suspiciousObjectExceptions` | `[{ <type>: value, description }]` |
| Remove exceptions | `POST /v3.0/threatintel/suspiciousObjectExceptions/delete` | `[{ <type>: value }]` |
| List / add custom scripts | `GET` / `POST /v3.0/response/customScripts` | multipart (`fileType`, `description?`, `file`) — id on `Location` header |
| Update / download / delete custom script | `POST /v3.0/response/customScripts/{id}/update` (multipart) · `GET` / `DELETE /v3.0/response/customScripts/{id}` | — |
| List / invite user accounts | `GET` / `POST /v3.0/iam/accounts` | invite: `{ email, role, authType, description? }` |
| Update / delete user account | `PATCH` / `DELETE /v3.0/iam/accounts/{id}` | update: `{ role?, status?, description? }` |
| List / create custom compliance rules | `GET` / `POST /beta/cloudPosture/customRules` | create: `{ name, description, categories[], riskLevel, provider, enabled, service, resourceType, attributes[], eventRules[], resolutionReferenceLink?, remediationNote? }` |
| Update / delete custom compliance rule | `PATCH` / `DELETE /beta/cloudPosture/customRules/{id}` | update: any subset of the create fields |

The identifier for a suspicious object or exception is keyed by the object type —
e.g. a domain is sent as `{ "domain": "evil.example.com", ... }`, a URL as
`{ "url": "…", ... }`.

## Notes

The add + list paths and the Bearer auth scheme are confirmed from the Trend Vision
One Automation Center documentation. The **remove** path
(`/v3.0/threatintel/suspiciousObjects/delete`), the exact list-response envelope and
the `daysToExpiration` units are inferred from v3.0 conventions and should be
**verified against a live Vision One tenant**. The v3.0 API also supports a
`fileSha256` object type, which can be added alongside the five shipped here.

The IAM Accounts and Cloud Risk Management Custom Rules endpoints are confirmed
against the official Trend `vision-one-mcp-server` Go client — see Coverage below
for the full audit and what was deliberately left out.

## Coverage (v0.3.0)

Coverage was re-audited against the official Trend Micro `pytmv1` SDK route table
(`trendmicro/tm-v1-pytv1`) and the official `vision-one-mcp-server` Go client
(`trendmicro/vision-one-mcp-server`) — between them the most complete public
records of which Trend Vision One v3.0/beta endpoints exist and which of those
are writable.

### Managed declarative configuration

| Configuration type | Vision One operations |
|---|---|
| Suspicious Objects | list / add-update / remove `/v3.0/threatintel/suspiciousObjects` |
| Exception List | list / add / remove `/v3.0/threatintel/suspiciousObjectExceptions` |
| Custom Scripts | list / add / update / download / delete `/v3.0/response/customScripts` |
| User Accounts | list / invite / update / delete `/v3.0/iam/accounts` |
| Custom Compliance Rules | list / create / update / delete `/beta/cloudPosture/customRules` |

### Intentionally excluded

- **IAM API Keys** (`/v3.0/iam/apiKeys`) — full CRUD exists in `pytmv1`, but
  create mints a plaintext secret returned exactly once; there is no API to set
  or rotate that secret to match a declared value, so a re-run of deploy would
  keep minting fresh live credentials rather than reconciling one. Update also
  needs `If-Match` optimistic concurrency, a pattern this app's other endpoints
  don't require. See CHANGELOG 0.3.0 for the full rationale.
- **Response Management block list** (`POST`/`POST .../delete
  /response/suspiciousObjects`) — add/remove exist in `pytmv1`, but there is no
  matching list/read endpoint anywhere in the confirmed surface, so this app
  cannot upsert, drift-detect or reliably roll it back; its own SDK docstring
  also describes the same blocking effect as the Suspicious Object List this
  app already manages.
- **Response/automation playbooks**, **notification rules / webhook channels**,
  **Service Gateway** and **Third-Party Integration** connectors are
  console-only features with no REST endpoint in the confirmed surface.
- **ASRM (Attack Surface Risk Management)** and **Endpoint Security policies**
  are entirely read-only in the confirmed surface (attack-surface exposure
  data, endpoint/agent/task inventory) — there is nothing to configure via API.
- **Data-loss-prevention rules** — no DLP-specific endpoint of any kind exists
  in the confirmed surface.
- Response Management **imperative actions** (isolate/restore endpoint,
  terminate process, collect file, run script, quarantine/restore/delete email,
  disable/enable/reset/sign-out domain account) and **Sandbox** submission are
  one-shot operations, not durable desired state.
- **Workbench alerts/notes**, **OAT detections**, **cyber-risk-exposure**
  (devices/users/cloud assets), **cloud-account inventory** (AWS/GCP/Alibaba),
  **container security**, **email security** and **cloud posture** scan
  results/settings are read-only or scan-triggering, not declarative
  configuration this app owns.

Primary references: the official `pytmv1` SDK route table
(`trendmicro/tm-v1-pytv1`, `model/enum.py`) and the official
`vision-one-mcp-server` Go client (`trendmicro/vision-one-mcp-server`,
`internal/v1client/*.go`).

Apache-2.0.
