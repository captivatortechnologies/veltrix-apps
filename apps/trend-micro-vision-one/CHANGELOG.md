# Changelog

All notable changes to the Trend Micro Vision One app are documented here.

## 0.3.0 — 2026-08-04

Two new config types, exhausting the meaningfully declarative write surface of
the Trend Vision One public API — the identity/access and cloud-compliance
families this app did not yet cover — plus a shared-client extension needed to
reach them.

- **User Accounts (`user-accounts`)** — manage Trend Vision One IAM console
  user accounts: invite by email, assign a role, control sign-in status
  (enabled/disabled) and record a description, over
  `/v3.0/iam/accounts`, reconciled **by email**. Invite (`POST`) only accepts
  email/role/authType/description — a new account's initial status is
  Vision One's own pending-acceptance state, not settable here; update
  (`PATCH /iam/accounts/{id}`) accepts role/status/description (auth type
  cannot be changed once an account exists). Rollback restores an updated
  account's prior role/status/description, or deletes an account this deploy
  invited; drift-detect flags a declared account that's gone, or whose
  role/status/description differs from what's live.
- **Custom Compliance Rules (`custom-compliance-rules`)** — manage Cloud Risk
  Management custom compliance rules: organization-wide, cloud-provider-scoped
  detection rules (name, description, categories, risk level, provider,
  service, resource type, enabled, plus JSON `attributes`/`eventRules` for the
  attribute-extraction and pass/fail logic) evaluated against every connected
  cloud account for that provider. These hang off the Vision One **beta**
  API prefix (`/beta/cloudPosture/customRules`), not `/v3.0` — the shared
  client gained `getBeta`/`postBeta`/`patchBeta`/`delBeta` for this (see
  below). Reconciled **by name** (list → match → `PATCH`/`POST`), the same
  shape Cisco Meraki's group-policies config type uses, since Vision One
  assigns the rule id on create. `attributes`/`eventRules` are authored as
  JSON arrays rather than flattened — their nested shape is large and
  vendor-specific; only that each entry looks like `{name, path}` /
  `{conditions}` is checked, as a warning, not an error.
- **Shared client** (`lib/visionOneApi.ts`) — added `patch()` (IAM account
  updates use `PATCH`, not `POST`) and the `getBeta`/`postBeta`/`patchBeta`/
  `delBeta` method family, generalizing the request path prefix so a config
  type can target Trend's `beta` API surface alongside the `v3.0` surface the
  rest of this app uses.

> Endpoints, methods and field names for both config types were verified
> against the official Trend `vision-one-mcp-server` Go client
> (`trendmicro/vision-one-mcp-server`, `internal/v1client/iam.go` and
> `internal/v1client/cloudposture.go`) — the IAM accounts invite/list/update/
> delete paths and body shapes, and the Cloud Risk Management custom-rule
> list/create/update/delete paths, request fields and enum values (categories,
> risk levels, providers) are all confirmed there. The list-response envelopes
> (`items` + `nextLink`) and the exact set of accepted Vision One role names
> (tenant-defined custom RBAC, not a fixed enum) remain inferred from v3.0
> convention and should be verified against a live Vision One tenant. The
> Cloud Risk Management endpoint's `beta` prefix is Trend's own designation —
> VERIFY it has not since graduated to `/v3.0`.
>
> **Considered but deferred**, after re-auditing the full API surface against
> the official Trend `pytmv1` SDK route table and the `vision-one-mcp-server`
> Go client (which between them cover IAM, threat intel, response management,
> sandbox, workbench, OAT, cyber-risk-exposure/ASRM, cloud-account
> management, container security, email security, endpoint security and
> cloud posture):
> - **IAM API Keys** (`/v3.0/iam/apiKeys`, full CRUD in `pytmv1`) — dropped.
>   Create mints a brand-new secret returned exactly once in the response
>   body; there is no way to set or rotate that secret to match a declared
>   value, so a canvas can only ever represent the key's metadata
>   (name/role/status/description), and re-running deploy against an
>   unresolvable prior key would mint yet another live credential rather than
>   reconciling one. Update also requires `If-Match` optimistic-concurrency
>   (an ETag captured from a prior `GET`), a pattern no other endpoint this
>   app manages needs. Same class of problem as the OAT-pipeline exclusion in
>   0.2.0: real, but not a fit for idempotent declarative config.
> - **Response Management block/allow list** (`/response/suspiciousObjects`
>   add/delete, confirmed in `pytmv1` as `ADD_TO_BLOCK_LIST`/
>   `REMOVE_FROM_BLOCK_LIST`) — dropped. There is no corresponding list/read
>   endpoint anywhere in the confirmed API surface, so deploy cannot
>   determine whether an object is already blocked (no upsert), drift-detect
>   cannot compare against live state, and rollback could only blindly
>   "remove what we think we added." Its own SDK docstring — "blocks the
>   objects on subsequent detections" — also describes the same effect as the
>   Suspicious Object List this app already manages via
>   `/threatintel/suspiciousObjects`, so it reads as a legacy response-action
>   alias rather than a second, independently-manageable list.
> - **Response/automation playbooks** — no create/update/delete endpoint of
>   any kind exists in the confirmed API surface; Vision One's Workflow &
>   Automation playbook designer is console-only.
> - **Notification rules / webhook channels** — same: Administration →
>   Notifications → Webhook List is a console-only feature per Trend's own
>   docs; no REST endpoint for it appears in `pytmv1` or the MCP server.
> - **ASRM (Attack Surface Risk Management) configuration** — every
>   cyber-risk-exposure endpoint (`crem.go`) is read-only (devices, users,
>   cloud assets, risk indicators); `/v3.0/asrm/securityPosture` itself is
>   `GET`-only. There is nothing to configure via API — ASRM surfaces
>   computed risk, it does not accept declarative input.
> - **Endpoint Security policies** — `endpoint.go` is 100% read-only (list/get
>   endpoints, list agent-update policies, list version-control policies,
>   list/get tasks). No policy-content write endpoint exists in the confirmed
>   surface.
> - **Data-loss-prevention rules** — no DLP-specific endpoint of any kind
>   appears anywhere in `pytmv1` or the MCP server's client.
> - **Connectors / Service Gateway** — cloud-account management (`cam.go`,
>   AWS/GCP/Alibaba) is read-only (list/get only, no add); Service Gateway and
>   Third-Party Integration are console-only per Trend's own documentation —
>   no REST endpoint for either appears in the confirmed API surface.

## 0.2.0 — 2026-08-01

Two new config types on the Vision One public REST API (v3.0), plus a small shared
API-client extension.

- **Exception List** config type — manage the Trend Vision One Suspicious Object
  Exception List (the safe / allow list): type (domain / ip / url / fileSha1 /
  fileSha256 / senderMailAddress), value and description, over
  `/threatintel/suspiciousObjectExceptions`, with validate / deploy (bulk upsert by
  object value) / rollback (restore prior or remove created) / health-check /
  drift-detect (a declared exception missing from the live list, or a changed
  description, is drift) / status.
- **Custom Scripts** config type — manage the Response Management custom-script
  library: file name, type (PowerShell `.ps1` / Bash `.sh`), contents and
  description, over `/response/customScripts`, upserted **by file name** (list →
  update the matching script by its id, else add). Rollback restores the prior
  contents of scripts it overwrote and deletes scripts it created; drift-detect
  compares file type, description and downloaded script contents (line endings
  normalized), and flags a declared script missing from the tenant.
- **Shared client** (`lib/visionOneApi.ts`) — added `postMultipart` (custom-script
  add/update are `multipart/form-data` uploads), `del` (custom-script delete) and
  response `headers` (the custom-script add returns the new id on the `Location`
  header, used for rollback).

> Endpoints, methods and field names for both config types were verified against
> the official Trend `pytmv1` SDK route table (`trendmicro/tm-v1-pytv1`,
> `model/enum.py` + `api/script.py`/`api/object.py`): the exception add/list/delete
> paths, the custom-script list/add/update/download/delete paths, the multipart
> `fileType`/`description`/`file` fields, the `powershell`/`bash` script types and
> the created-id `Location` header are all confirmed there. The list-response
> envelope (`items` + `nextLink`), the `?top=1` health probe and the error envelope
> remain inferred from v3.0 conventions and should be verified against a live Vision
> One tenant.
>
> **Considered but deferred:** OAT (Observed Attack Techniques) data pipelines
> (`/oat/dataPipelines`) are genuinely writable, but a registered pipeline is keyed
> only by a server-assigned id with no user-facing name, so it has no stable natural
> identity for idempotent upsert-by-identity — it does not fit the config-as-code
> model cleanly and was left out. Custom-script **execution**
> (`/response/endpoints/runScript`) is an imperative one-shot action, not declarative
> config, so it is out of scope for this config type (which manages the script
> library, not runs).

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Suspicious Objects** config type — add / update / remove Trend Vision One
  user-defined suspicious objects (type — domain / ip / url / fileSha1 /
  senderMailAddress —, value, scan action block/log, risk level, description and
  days to expiration) over the Vision One public REST API (v3.0,
  `/threatintel/suspiciousObjects`), with validate / deploy (upsert by object
  value) / rollback (restore prior or remove created) / health-check / drift-detect
  / status.
- **Connectivity test** against the Vision One public API
  (`GET /v3.0/threatintel/suspiciousObjects?top=1`, Bearer API token).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  Vision One tenant; saving a connection registers `trend-vision-one-tenant` as a
  deploy target).

> The add + list endpoints and Bearer auth are confirmed from the Trend Vision One
> Automation Center docs. The remove endpoint
> (`/threatintel/suspiciousObjects/delete`), the list-response envelope and the
> `daysToExpiration` units are inferred from v3.0 conventions and should be verified
> against a live Vision One tenant.
