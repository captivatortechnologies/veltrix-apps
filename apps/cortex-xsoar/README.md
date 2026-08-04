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
| **Incident Fields** | `GET /incidentfields`, `POST /incidentfields/import`, `POST /incidentfields/delete` | cliName (id derived as `incident_<cliName>`) |
| **Indicator Fields** | `GET /incidentfields`, `POST /incidentfields/import`, `POST /incidentfields/delete` | cliName (id derived as `indicator_<cliName>`) |
| **Classifiers** | `POST /classifier/search`, `POST /classifier/import`, `POST /classifier/delete` | caller-chosen id |
| **Mappers** (incoming/outgoing) | `POST /classifier/search`, `POST /classifier/import`, `POST /classifier/delete` | caller-chosen id |
| **Jobs** (scheduled / time-triggered) | `POST /jobs/search`, `POST /jobs`, `DELETE /jobs/{id}` | job name |
| **Integration Instances** | `POST /settings/integration/search`, `PUT /settings/integration`, `DELETE /settings/integration/{id}` | instance name |

Each type reconciles by a **stable identity** (a name, a cliName, or a caller-chosen
id): the deploy lists the live objects, matches on identity, then creates or updates.
Rollback deletes objects it created and restores objects it updated to their captured
prior state. Built-in / locked objects (system incident types such as *Unclassified*,
locked lists, locked fields/classifiers) are never modified.

### Incident & indicator fields — one server object, split for a clearer authoring model

XSOAR stores custom incident fields and indicator fields as the **same object type**,
listed through one endpoint (`GET /incidentfields`) and saved through one import
endpoint (`POST /incidentfields/import`). The two are told apart by the `group` number
(`0` = incident field, `2` = indicator field — XSOAR's own `GroupFieldTypes` enum) and
by the `id` prefix (`incident_<cliName>` / `indicator_<cliName>`). This app models them
as **two config types** (`xsoar-incident-fields`, `xsoar-indicator-fields`) sharing one
plumbing module (`config-types/lib/xsoarFields.ts`), because the two have meaningfully
different associations (incident types vs. indicator types) and a different available
`type` enum — indicator fields drop `attachments`, `internal` and `timer`, which only
make sense on an incident.

A field's **cliName** (lowercase letters and digits only) is what you declare; the
server `id` is always *derived* as `incident_<cliName>` / `indicator_<cliName>` rather
than typed directly, which rules out an entire class of "forgot the prefix" bugs. A
cliName that collides with one of XSOAR's reserved internal columns (`name`, `type`,
`score`, `modified`, …) is rejected at validate time — the exact reserved-word list
XSOAR's own content validator enforces.

### Classifiers & mappers — also one server object, split the same way

Classifiers and incoming/outgoing mappers are likewise the **same object type**, listed
through `POST /classifier/search` and saved through `POST /classifier/import`, told
apart by `type` (`classification` vs. `mapping-incoming` / `mapping-outgoing`). This app
splits them into `xsoar-classifiers` and `xsoar-mappers` for the same reason as fields —
distinct fields (a mapper has a `direction`; a classifier does not) — sharing one
plumbing module (`config-types/lib/xsoarClassification.ts`).

Each reconciles by a **caller-chosen id**, which is also the required `classifierId`
form field sent on every save (confirmed against the official generated API client —
this field is not optional). The actual routing logic — a classifier's `keyTypeMap` +
`transformer`, a mapper's `mapping` — is a deep, variable, per-integration schema.
Following the precedent set by Cisco Meraki's Group Policies config type, it is authored
as **one JSON blob** merged onto the typed fields rather than exhaustively modeled: the
canvas validates that it parses to a JSON object, and XSOAR validates the rest at
deploy time. Drift detection reconciles the object's **presence** and its typed fields
only — the JSON blob is not diffed key-by-key, the same boundary Meraki's group-policies
type draws around its own `policy` blob.

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

## Development

```
cd apps/cortex-xsoar
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs cortex-xsoar          # run handler tests
node ../../scripts/validate-app.mjs apps/cortex-xsoar  # validate against the app contract
```

## Coverage (v1.3.0)

Coverage was audited against the officially generated Cortex XSOAR API client
(`demisto-py`'s `DefaultApi`), `demisto-sdk`'s content-graph upload path (the
per-content-type `_upload`/`_client_upload_method` implementations, which are the
actual verified request shapes `demisto-sdk upload` sends to a live server) and
`demisto-sdk`'s `Downloader.ITEM_TYPE_TO_ENDPOINT` mapping (the verified listing
endpoints), cross-checked against real shipped content in the `demisto/content`
repository for field/object shapes (2026-08-04).

### Managed declarative configuration

| Configuration type | Confirmed via | Notes |
| --- | --- | --- |
| Lists | `demisto-sdk`'s `List._upload` (`POST /lists/save`) + this app's own prior verification of `GET /lists` / `POST /lists/delete` | Name-keyed; a list's id equals its name |
| Incident types | `demisto-py`'s `create_or_update_incident_type` (`POST /incidenttype`) + this app's own prior verification of `GET /incidenttype` / `POST /incidenttype/delete` | Name-keyed; built-in types (e.g. *Unclassified*) are locked |
| Incident fields | `demisto-py`'s `import_incident_fields` + `demisto-sdk`'s `IndicatorIncidentField._upload` (`POST /incidentfields/import`); listing via `Downloader.ITEM_TYPE_TO_ENDPOINT[FIELD]` (`GET /incidentfields`) | cliName-keyed; id derived, `group: 0` |
| Indicator fields | Same endpoints as incident fields — one server object, discriminated by `group`/id prefix | cliName-keyed; id derived, `group: 2` |
| Classifiers | `demisto-py`'s `import_classifier` + `demisto-sdk`'s `Classifier._client_upload_method` (`POST /classifier/import`); listing via `Downloader.ITEM_TYPE_TO_ENDPOINT[CLASSIFIER]` (`POST /classifier/search`) | id-keyed (`classifierId` required on every save); `type: classification` |
| Mappers | Same endpoints as classifiers — one server object, discriminated by `type` | id-keyed; `type: mapping-incoming` / `mapping-outgoing` |
| Jobs | This app's own prior verification (`POST /jobs/search`, `POST /jobs`, `DELETE /jobs/{id}`) | Name-keyed scheduled/time-triggered jobs |
| Integration instances | This app's own prior verification (`POST /settings/integration/search`, `PUT /settings/integration`, `DELETE /settings/integration/{id}`) | Name-keyed; encrypted parameters (types 4/9) are set on create but masked on read and never diffed |

**Delete is the one edge not independently confirmed for the four new types.** No
source above — not the official generated client, not `demisto-sdk`'s content-graph
upload path — documents a field or classifier/mapper delete contract (`demisto-sdk`
itself never deletes individual content items; it works against source-controlled
packs). The delete calls this app makes (`POST /incidentfields/delete`,
`POST /classifier/delete`) follow the same `POST /<resource>/delete` action
convention already **shipped and working** in this app for lists and incident types,
and — for fields specifically — the fact that `/incidentfields` is a bulk collection
endpoint with no per-item GET is itself a signal that its delete is array-bodied.
Rollback surfaces any non-404 failure verbatim rather than reporting a false success,
but this specific contract should be confirmed against your own server before relying
on unattended production rollback for these four types. Every other write path (list,
create, update) for every managed type is independently confirmed.

### Intentionally excluded

- **Pre-process rules.** `GET /preprocess/rules` and `DELETE /preprocess/rule/{id}`
  exist, but `demisto-sdk`'s own `PreProcessRule._upload` **explicitly raises**
  `NotIndivitudallyUploadableException` — the SDK's own authors have confirmed there is
  no supported way to save one via the API. Dropped, not shipped as an unreliable
  write.
- **Roles.** Not a content-graph object type at all (no `ContentType.ROLE`), absent
  from the official generated `demisto-py` client, and absent from `demisto-sdk`'s
  newer typed `xsoar_api_client.py` — the three sources everything else in this
  app's coverage is checked against. No stable, documented REST contract could be
  established for role management, so it is dropped rather than guessed at.
- **Playbooks.** `POST /playbook/search` (list) and `POST /playbook/delete` (delete)
  are confirmed, but a playbook's content is a **task graph** — sub-playbook
  references, branching conditions, and view/layout coordinates — not a flat or
  JSON-blob-shaped record like a classifier's routing rules. A partial declarative
  edit risks silently corrupting a production automation's task wiring in a way
  validate-time checks cannot catch. Genuinely not cleanly round-trippable as typed
  canvas fields; excluded per this exercise's own guidance to drop non-round-trippable
  playbook graphs.
- **Layouts, widgets, dashboards, reports.** Declarative in principle (confirmed
  `GET /layouts` + `import_layout`), but their content is UI-coordinate/rendering
  data (tab positions, pixel layout, incident-to-alert view mappings) rather than
  security/operational configuration — out of scope for this app's SOAR
  content-as-code surface, matching the boundary the existing three types already
  drew.
- **Indicator types (reputations).** Confirmed listing/import (`GET /reputation`,
  `import_reputation_handler`), but reputations are almost always installed as part
  of a Marketplace content pack (threat-intel feeds ship their own); managing them
  independently of the packs that define them invites drift against the pack's own
  updates. Left for a future release if real demand emerges.
- **Integration instance secret parameters.** Encrypted/credential parameters
  (types 4 and 9) are set on create but XSOAR masks them on every read — the existing
  `xsoar-integration-instances` type already never reads them back, diffs them, or
  stores them; this exercise reconfirmed the boundary rather than changing it.
- **Runtime data and imperative actions.** Incidents, indicators, war-room entries,
  investigation state, task completion, incident-type auto-run *execution* (as
  opposed to its declarative configuration), content-pack install/marketplace
  sync, and server administration (Docker images, audits themselves) are operational
  or one-shot actions, not durable desired state, and are out of scope for every
  config type in this app.

Primary references: [`demisto-py`](https://github.com/demisto/demisto-py) (the
officially generated REST client), [`demisto-sdk`](https://github.com/demisto/demisto-sdk)
(`commands/content_graph/objects/*.py` for per-type upload behavior,
`commands/download/downloader.py` for listing endpoints,
`commands/common/clients/xsoar/xsoar_api_client.py` for the newer typed client), and
example content in [`demisto/content`](https://github.com/demisto/content) for field,
classifier and mapper JSON shapes.
