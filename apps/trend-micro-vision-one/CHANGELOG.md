# Changelog

All notable changes to the Trend Micro Vision One app are documented here.

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
