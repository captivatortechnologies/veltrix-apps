# Splunk SOAR (Veltrix App)

Connect Veltrix to **Splunk SOAR** (Security Orchestration, Automation and
Response, formerly Phantom) and manage it as code over its REST API
(`/rest/*`, HTTPS port 443) — the instance connection profile, event
taxonomy (severities, container statuses, container labels), CEF custom
fields, roles and permissions, assets, automation/service accounts, and
custom lists — each flowing through the Veltrix pipeline: validate → deploy →
health check → drift detect → rollback.

Playbooks and other automation code are **intentionally out of scope** — see
[Coverage](#coverage) for why.

## Configuration types

| Type | What it manages | SOAR endpoints |
|------|-----------------|----------------|
| `connection` | SOAR instance connection profile: name, description; endpoint reachability, TLS, timeout, retries | `GET /rest/version` |
| `severities` | Container/artifact severities: name, color, default flag | `GET/POST/DELETE /rest/severity` |
| `container-statuses` | Custom container status labels: name, category (new/open/resolved), default flag | `GET/POST/DELETE /rest/container_status` |
| `container-labels` | Ensures declared container labels exist (add-only — no rename) | `GET /rest/system_settings/labels`, `POST /rest/system_settings/events` |
| `custom-fields` | Custom CEF field definitions: name, data types | `GET/POST/DELETE /rest/cef` |
| `custom-lists` | Named lookup/allow/block lists — full content replace | `GET/POST/DELETE /rest/decided_list` |
| `roles` | Roles and their permission flags across 9 categories | `GET/POST/DELETE /rest/role` |
| `automation-accounts` | Automation (service) accounts — never manages passwords | `GET/POST/DELETE /rest/ph_user` |
| `assets` | Asset instances of installed SOAR apps — non-secret fields only; per-app configuration is write-only | `GET/POST/DELETE /rest/asset` |

## Prerequisites

1. **A Splunk SOAR deployment** reachable from the platform over HTTPS (the
   REST API is served on the web port, default `443`).
2. **A component** of type `soar-instance` whose hostname is your SOAR host
   (e.g. `soar.example.com`).
3. **A credential** assigned to the component's tool: the **automation API
   token** (from the SOAR console under **User Settings → API Access**) in the
   `API token` field. Basic auth (`username` / `password`) is supported as a
   fallback. The token is sent as the `ph-auth-token` header.
4. **Connectivity** to the instance (direct HTTPS or a connectivity provider
   such as Tailscale).

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| `verify_ssl` | `true` | Verify the SOAR instance's TLS certificate on every request |
| `request_timeout_seconds` | `30` | Per-request timeout for SOAR REST calls |
| `max_retries` | `3` | Number of times to retry a failed SOAR REST request |

## Canvas model

`connection` is a single, non-repeatable canvas section. Every other type is a
**repeatable item** — each item is one record (a severity, a role, an asset...)
identified by a stable field (usually `name`) used to upsert and detect drift.
See each type's `config-types/<id>/canvas.yaml` for its exact fields.

### `connection` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Unique per canvas; max 120 chars. |
| `description` | Optional notes (environment, owner, purpose). |

## Pipeline semantics

**`connection`** — a connection profile is never pushed to SOAR:

- **validate** — every section needs a non-empty, unique connection name.
- **deploy** — verifies the instance is reachable and authenticating
  (`GET /rest/version`); returns an empty `rollbackData` (no external state).
- **rollback** — no-op; there is no external state to revert.
- **healthCheck** — a single `server_reachable` check (`GET /rest/version`);
  fails closed when credential or connectivity is missing.
- **driftDetect** — reachability only; a reachable instance reports no drift, an
  unreachable one reports a critical diff.

**Every other type** shares one shape (Splunk SOAR's uniform REST convention —
see Coverage for citations):

- **deploy** — upserts by identity: `GET` the live collection, `POST` a new
  record when unseen, `POST /<id>` (full replace) when it already exists.
  `rollbackData` captures the prior body (or nothing, for a new record).
- **rollback** — a record THIS deploy created is deleted (`DELETE /<id>`); a
  record it updated is restored from the captured prior body. **`DELETE`
  requires a user-authenticated credential (username + password) — an
  automation API token cannot delete.** If the connection's credential is
  token-only, rollback of a *newly-created* record surfaces a clear failure
  rather than silently no-op'ing (`custom-lists` is the one exception — its
  `DELETE` accepts a token too). Attach a user credential capable of deletion
  if this matters for your environment.
- **driftDetect** — read-only `GET`; a declared record missing live is
  critical drift, a field mismatch is a warning. Best-effort: an unreadable
  collection reports no drift rather than a false positive.
- **healthCheck** / **getStatus** — identical across every type (they all
  target the same `soar-instance` component): `GET /rest/version` reachability,
  and the platform's own deployment record.

## Coverage

Coverage was researched against the official Splunk SOAR REST API reference
(help.splunk.com / docs.splunk.com, SOAR PlatformAPI, versions 7.0–7.1) — see
citations per row below. Every write path follows the platform's own generic
REST conventions, confirmed on its "Using the REST API" overview pages: list/
read via `GET /rest/<type>[/<id>]` (`{ count, data: [...], num_pages }`,
`page_size=0` for "all"), create via `POST /rest/<type>`, update via
`POST /rest/<type>/<id>` (**full replace** — an omitted field resets to its
default), delete via `DELETE /rest/<type>/<id>`.

### Managed declarative configuration

| Configuration type | REST operations | Identity | Notes |
| --- | --- | --- | --- |
| Severities | `GET/POST/DELETE /rest/severity` ([RESTSeverity](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/severity-endpoints/rest-severity)) | `name` | name (≤20 chars), color (fixed 10-color palette), default flag; deleting a severity name never changes the severity already recorded on existing containers/artifacts |
| Container Statuses | `GET/POST/DELETE /rest/container_status` ([RESTStatus](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/status-endpoints/rest-status)) | `name` | name (≤20 chars), category (new/open/resolved), default flag; SOAR itself enforces the 30-total cap and "at least one active status per category" — this app warns at 30 declared but defers the final word to SOAR |
| Container Labels | `GET /rest/system_settings/labels`, `POST /rest/system_settings/events` (`add_label`/`remove_label`) ([RESTSystem](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/system-settings-endpoints/rest-system-settings)) | `label_name` | add/remove only — **no rename** exists on this API; deploy only ADDS declared labels that don't already exist and never removes one dropped from the canvas (this app doesn't own the whole label namespace) |
| CEF Custom Fields | `GET/POST/POST-<id>/DELETE /rest/cef` ([CEF endpoints](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/cef-endpoints)) | `name` | name + one or more data types (e.g. `ip`, `domain`, `hash sha256`) SOAR uses to auto-link matching values across artifacts; the read-only `type` (`default`\|`custom`) SOAR reports back is never sent or compared |
| Custom Lists | `GET/POST/POST-<id>/DELETE /rest/decided_list` ([REST Lists](https://help.splunk.com/en/splunk-soar/soar-cloud/rest-api-reference/list-endpoints/rest-lists)) | `name` | a named 2D-array table (allow/block/lookup lists); every deploy REPLACES the full `content` (not a row append/patch) via the canvas's CSV-shaped textarea; the ONE type in this app whose `DELETE` accepts an automation token too, per the platform's own "Delete Records" reference |
| Roles | `GET/POST/POST-<id>/DELETE /rest/role` ([RESTRoles](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/role-management-endpoints/rest-roles-and-permissions)) | `name` | name, description, and all 4 documented flags (view/edit/delete/execute) across the 9 documented permission categories (`apps`, `assets`, `containers`, `container_labels`, `repository`, `tenant`, `playbooks`, `system_settings`, `users_roles`); drift compares permissions order-independently since the live array's order isn't guaranteed |
| Automation Accounts | `GET/POST/POST-<id>/DELETE /rest/ph_user` ([RESTUser](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/user-management-endpoints/rest-user)) | `username` | scoped to `type: "automation"` only — username, roles, allowed IPs (CIDR), default label/tenant, and profile metadata; the default `GET` excludes automation accounts, so this type always adds `include_automation=true` |
| Assets | `GET/POST/POST-<id>/DELETE /rest/asset` ([RESTAssets](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/asset-endpoints/rest-asset)) | `name` | identity (name/product_vendor/product_name), ownership/voting, tags, tenants, and structured polling settings (`configuration.ingest`) are diffable and restorable; the free-form `configuration` object is **write-only** (see below) |

### Secret material is never read or written

- **Assets**' `configuration` object is defined per installed SOAR app and
  commonly mixes ordinary settings with credential fields (API keys,
  passwords) this app cannot tell apart generically — the Asset REST reference
  documents no masking behavior for it. It is sent on every deploy but never
  read back, diffed, or restored on rollback: an asset this deploy newly
  created is deleted on rollback (nothing was ever captured, so nothing can
  leak); an asset it updated is left as-is, since a full-replace `POST`
  without the live `configuration` this app never saw would reset it to
  defaults — the same write-only philosophy `apps/cribl`'s Secrets type uses.
- **Automation Accounts** never sends `password` at all. Per SOAR's user
  reference, `password` is required only for `type: "normal"` (local human
  accounts) and optional for `automation` — this type is scoped to
  `automation` specifically so it never needs one. Human accounts
  (normal/LDAP/OpenID/SAML2) are intentionally out of scope (see below).
- **Roles**' per-object allow-lists (restricting `container_labels`/
  `repository`/`tenant` permissions to specific ids via the documented `extra`/
  `object_id` fields) are **not modeled** — only the blanket
  view/edit/delete/execute flags per category. Resolving specific label/repo/
  tenant ids into that shape wasn't confirmed against a live instance; this is
  a deliberate, narrower-than-possible scope rather than a guess.

### Intentionally excluded

- **Playbooks and other automation code** are versioned in SOAR's own Source
  Control (Git-backed repositories), not canvas configuration — a playbook is
  Python code with branching logic, not a declarative record with a stable
  identity to diff. The [Role Management reference](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/role-management-endpoints/rest-roles-and-permissions)
  even lists `playbooks` as a *permission category* (who may view/edit/
  execute them), reinforcing that playbooks themselves are managed content,
  not settings. Same reasoning excludes **Custom Functions** and **Automation
  Broker** scripts.
- **Workbook Templates** (`/rest/workbook_template`, `/rest/workbook_phase_template`,
  `/rest/workbook_task_template`) were researched and are genuinely
  declarative in shape (name, phases, tasks) — but the
  [Workbook endpoints reference](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/workbook-endpoints/rest-workbook)
  documents **`POST`-create only**: no `GET` to list/find a template by name,
  no `PUT`/`POST`-to-id update, and no `DELETE`. Without a way to detect an
  existing template, every re-deploy would create a duplicate rather than
  upsert — this fails the round-trippable bar this pass holds every other type
  to, so it is deferred rather than shipped half-working.
- **Tenants / Multi-tenancy** (`/rest/tenant`) is **`GET`-only** in the
  documentation — no `POST`/`PUT` for creating or editing a tenant (including
  its per-tenant SLA response-time overrides) was found. Multi-tenancy is an
  on-premises-only, Enterprise-gated feature with, per this research, no REST
  write surface at all.
- **System Settings** (`/rest/system_settings` — auth providers, feature
  flags) is a **whole-section, full-replace** API that mixes unrelated
  toggles with identity-provider secrets (LDAP bind password, SAML
  certificates) in the same monolithic object ("the entirety of `auth_settings`
  must be submitted in a single post"). Unlike MISP's flat, single-purpose
  Admin Settings store, there is no clean way to expose just the non-secret
  toggles here without risking an admin accidentally clearing or leaking IdP
  credentials on an unrelated feature change. Deferred for a follow-up pass
  that can research the auth-provider shapes properly rather than guess.
- **One-shot actions** — running a playbook (`/rest/run_playbook`), running an
  app action (`/rest/run_action`), approvals, and worker/queue operations are
  imperative commands, not durable desired state, and stay out of the canvas
  model (same reasoning the rest of this platform's apps use for one-shot
  actions).
- **Read-only surfaces** — Artifacts, Containers, Notes, Evidence, Audit,
  HUD and Indicators are the SOAR-generated case data this platform's
  Security-as-Code pipeline manages workflow *around*, not configuration to
  author.

Primary references: the official [Splunk SOAR REST API reference](https://help.splunk.com/en/splunk-soar/soar-on-premises/rest-api-reference/7.0.0/using-the-splunk-soar-rest-api/using-the-rest-api-reference-for-splunk-soar-on-premises)
(query/update/delete conventions), and each endpoint cited in the per-type
`_shared.ts`/`deploy.ts` doc comments. Endpoint shapes should be verified
against a live SOAR instance before relying on an untested corner (e.g. the
exact `formatted_content` JSON shape for Custom Lists, or a permission
category's applicable flag subset for Roles).

## Development

```
cd apps/splunk-soar
node node_modules/typescript/bin/tsc --noEmit         # typecheck
node ../../scripts/test-apps.mjs splunk-soar          # run handler tests
node ../../scripts/validate-app.mjs apps/splunk-soar  # validate against the app contract
```

## License

Apache-2.0
