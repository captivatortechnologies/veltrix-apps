# 🧩 MISP

Manage [MISP](https://www.misp-project.org) — the open-source Threat Intelligence
Platform — as code on the Veltrix Security-as-Code platform. Author threat-intel
configuration in the Configuration Canvas and drive it through the pipeline
(validate → deploy → rollback → health-check → drift-detect → status), with BYOL
infrastructure provisioning.

## How it's managed

MISP exposes a single, uniform **REST API** over HTTPS (443). This app applies
configuration over that API:

- **HTTPS REST** — feeds and other objects via the MISP REST API. Authentication
  is a MISP **automation key** carried verbatim in the `Authorization` header (no
  Bearer prefix), stored as the connection credential's API token. MISP commonly
  ships a **self-signed certificate**, which the transport tolerates.

## Configuration types

MISP exposes a single, uniform REST API, so all 13 configuration types below
apply over the same transport (`lib/mispApi.ts`) — see **Coverage** for the full
audit of what was added, why, and what was deliberately left out.

| Type | Surface |
|---|---|
| **Threat Feeds** | `/feeds`, `/feeds/add`, `/feeds/edit/{id}` |
| **Taxonomies** | `/taxonomies`, `/taxonomies/enable\|disable/{id}` |
| **Warninglists** | `/warninglists`, `/warninglists/toggleEnable` |
| **Noticelists** | `/noticelists`, `/noticelists/enableNoticelist/{id}[/true]` |
| **Tags** | `/tags/index`, `/tags/add`, `/tags/edit/{id}`, `/tags/delete/{id}` |
| **Galaxies** | `/galaxies`, `/galaxies/add`, `/galaxies/edit/{id}`, `/galaxies/enable\|disable/{id}` |
| **Galaxy Clusters** | `/galaxy_clusters/index/{galaxyId}`, `/galaxy_clusters/add/{galaxyId}`, `/galaxy_clusters/edit/{id}`, `/galaxy_clusters/publish/{id}` |
| **Sharing Groups** | `/sharing_groups`, `/sharing_groups/add`, `/sharing_groups/edit/{id}` |
| **Organisations** | `/organisations`, `/admin/organisations/add`, `/admin/organisations/edit/{id}` |
| **Sync Servers** | `/servers`, `/servers/add`, `/servers/edit/{id}` |
| **Roles** | `/roles/index`, `/admin/roles/add`, `/admin/roles/edit/{id}`, `/admin/roles/delete/{id}` |
| **Users** | `/admin/users/index`, `/admin/users/add`, `/admin/users/edit/{id}`, `/admin/users/delete/{id}` |
| **Admin Settings** | `/servers/getSetting/{name}`, `/servers/serverSettingsEdit/{name}` |

The feed URL is the stable identity used to upsert (add vs edit) and to detect
drift; deploy snapshots the prior feed body so rollback can restore it (or disable
a feed it created). The other types each follow the same
find-by-identity → edit-or-add → snapshot-for-rollback shape; see Coverage for
per-type identity fields and rollback semantics.

## BYOL infrastructure

`infra/spec.ts` declares the MISP stack (`misp-core` web/API + workers,
`database` MariaDB, `redis`, and an all-in-one `standalone`) as a declarative
`InfraSpec` composed from the generic OpenTofu modules — no tool-specific HCL. The
generic provisioning worker runs `infra/bringup/misp-setup.mjs` after `tofu apply`,
gating readiness on the MISP web UI + workers.

## Notes

MISP REST API paths (`/servers/getVersion`, `/feeds`, `/feeds/add`,
`/feeds/edit/{id}`) follow MISP 2.4 conventions; **verify against a live MISP 2.4
instance**. TLS verification is off by default (self-signed) and configurable via
the `verify_tls` setting.

## Development

```
cd apps/misp
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs misp             # run handler tests
node ../../scripts/validate-app.mjs apps/misp     # validate against the app contract
```

## Coverage (v0.5.0)

Coverage was audited against the MISP core REST controllers
([MISP/MISP@2.4](https://github.com/MISP/MISP/tree/2.4/app/Controller)) and the
PyMISP client ([MISP/PyMISP@main](https://github.com/MISP/PyMISP/blob/main/pymisp/api.py)),
which together are the closest thing MISP has to an authoritative API reference
— this app's own OpenAPI docs page does not reliably diff cleanly across
releases. Every write path below was traced to its controller `add()`/`edit()`/
`save()` method, not just PyMISP's wrapper, to catch surface PyMISP hasn't
caught up to yet (see Galaxies).

### Managed declarative configuration

| Configuration type | REST operations | Identity | Notes |
| --- | --- | --- | --- |
| Threat Feeds | `GET /feeds`, `POST /feeds/add`, `POST /feeds/edit/{id}` | feed URL | unchanged from v0.1.0 |
| Taxonomies | `GET /taxonomies`, `POST /taxonomies/enable\|disable/{id}` | namespace | enable/disable only — taxonomies are a library, not creatable |
| Warninglists | `GET /warninglists`, `POST /warninglists/toggleEnable` | name | enable/disable only — same reason |
| Noticelists | `GET /noticelists`, `POST /noticelists/enableNoticelist/{id}[/true]` | name | enable/disable only, same reason; route shape (trailing `/true` to enable, no segment to disable) matches PyMISP's own `enable_noticelist`/`disable_noticelist` exactly ([MISP/MISP#4856](https://github.com/MISP/MISP/issues/4856)) |
| Tags | `GET /tags/index`, `POST /tags/add`, `POST /tags/edit/{id}`, `POST /tags/delete/{id}` | name (MISP enforces uniqueness) | full CRUD; `TagsController::add()` silently no-ops on a name collision instead of erroring, so deploy always resolves the live list first and routes to edit |
| Galaxies | `GET /galaxies`, `POST /galaxies/add`, `POST /galaxies/edit/{id}`, `POST /galaxies/enable\|disable/{id}`, `POST /galaxies/delete/{id}` | `type` | full CRUD for **custom** galaxies only — MISP's own default library (mitre-attack-pattern, ...) is never matched or edited. **Not in PyMISP** (`add`/`edit`/`enable`/`disable` exist only in `GalaxiesController.php`, added to MISP core after PyMISP's galaxy wrapper was last touched) — traced directly from the controller source |
| Galaxy Clusters | `GET /galaxies` (resolve), `POST /galaxy_clusters/index/{galaxyId}`, `POST /galaxy_clusters/add/{galaxyId}`, `POST /galaxy_clusters/edit/{id}`, `POST /galaxy_clusters/publish\|unpublish/{id}`, `POST /galaxy_clusters/delete/{id}` | `value`, scoped to a resolved `galaxy` | entries within any galaxy (default or custom); a cluster whose live match is itself a default cluster is skipped, matching PyMISP's own guard |
| Sharing Groups | `GET /sharing_groups`, `POST /sharing_groups/add`, `POST /sharing_groups/edit/{id}` | name | unchanged from v0.2.0 |
| Organisations | `GET /organisations`, `POST /admin/organisations/add`, `POST /admin/organisations/edit/{id}` | name | unchanged from v0.2.0 |
| Sync Servers | `GET /servers`, `POST /servers/add`, `POST /servers/edit/{id}` | remote URL | unchanged from v0.2.0 |
| Roles | `GET /roles/index`, `POST /admin/roles/add`, `POST /admin/roles/edit/{id}`, `POST /admin/roles/delete/{id}` | name | full CRUD over all 28 currently-surfaced permission flags (`Role::generatePermFlags()` plus the 4 legacy base perms); `perm_full` is a legacy, UI-unexposed DB column and is intentionally excluded |
| Users | `GET /admin/users/index`, `POST /admin/users/add`, `POST /admin/users/edit/{id}`, `POST /admin/users/delete/{id}` | email (MISP enforces uniqueness) | provisions identity, org/role assignment and account state only — see the secret-material exclusion below |
| Admin Settings | `GET /servers/getSetting/{name}`, `POST /servers/serverSettingsEdit/{name}` | dotted setting name | MISP's single generic key/value config store; `redacted` settings 403 on read and are never written, `cli_only` settings are detected and skipped rather than attempted |

### Secret material is never read or written

- **Sync Servers** already treated the remote `authkey` as write-only (sent, never
  compared) — unchanged.
- **Users**: `password`, `authkey`, `confirm_password` and `external_auth_key` are
  not fields on this config type at all. A new account is provisioned with no
  password; `Notify On Create` asks MISP to email the user its own
  password-reset link through MISP's existing flow, so this app never
  generates, stores or transmits a credential.
- **Admin Settings**: a setting MISP itself marks `redacted` (`Security.salt`,
  SMTP credentials, encryption keys, ...) throws a 403 on `GET
  /servers/getSetting/{name}` — this type treats that the same as "not found"
  and skips it. It is architecturally incapable of writing one, since it never
  has a prior value to diff against or confirm.

### Consolidated rather than duplicated

- **"Server-sync config"** is not a separate REST surface. Sync-shaping settings
  such as `MISP.host_org_id`, `MISP.baseurl`, `MISP.external_baseurl` and
  `MISP.manager` are ordinary rows in the same generic `servers/serverSettings`
  store every other admin setting lives in (confirmed against
  `ServersController::serverSettingsEdit()` — one endpoint, keyed by setting
  name, for the entire store). A dedicated "server-sync config" type would
  duplicate Admin Settings' read/write path for no behavioral difference, so
  sync-related server settings are just declared there.
- **"Sightings config"** does not exist as a distinct surface either.
  `SightingsController` only exposes CRUD for individual sighting *records* —
  runtime observations tied to a specific attribute/event (see below); any
  sighting-related *policy* toggle (e.g. `Sightings_policy`,
  `Sightings_anonymize`) is, again, just another Admin Settings row.

### Intentionally excluded

- **Events & Attributes** (and their Sightings) are the threat data this
  platform manages workflow *around*, not declarative configuration — they are
  the payload feeds/sync exchange, not the pipeline's job to author. Sightings
  specifically are point-in-time observations (`SightingsController::add`,
  scoped to one attribute/event), the same "runtime data, not desired state"
  reasoning that excludes events themselves.
- **Object Templates** are read-only from this API: `ObjectTemplatesController`
  exposes `view`/`index`/`delete` (of a locally-cached copy) and `update` (an
  imperative git-pull of the upstream template library) — there is no
  `add`/`edit`. Object templates are authored upstream in
  [MISP/misp-objects](https://github.com/MISP/misp-objects) and synced in, not
  declared per-instance.
- **Warninglist/Taxonomy/Noticelist *creation*** (new custom lists, as opposed to
  enabling/disabling MISP's shipped ones) has no REST endpoint — these three
  libraries are only extended by dropping new JSON definitions into the
  instance's filesystem and running their `update` action, which is out of
  reach of a REST-only integration.
- **Decaying Models**, **Correlation Exclusions**, **Cryptographic Keys** and
  **Auth Keys** are real, further REST-manageable surfaces this pass did not
  reach — plausible future config types, deferred rather than rushed.
- Server-to-server **pull/push actions**, galaxy/taxonomy/warninglist/noticelist
  **`update`** (git-pull) actions, worker restarts and other one-shot
  operations are imperative commands, not durable desired state, and stay out
  of the canvas model.

Primary references: [MISP core Controllers (2.4 branch)](https://github.com/MISP/MISP/tree/2.4/app/Controller),
[PyMISP `api.py`](https://github.com/MISP/PyMISP/blob/main/pymisp/api.py), and
each endpoint cited in the per-type `_shared.ts`/`deploy.ts` doc comments.

Apache-2.0.
