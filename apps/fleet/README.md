# 🚀 Fleet

Manage [Fleet](https://fleetdm.com) — the open-source **osquery** fleet-management
platform (endpoint visibility, vulnerability and device management) — as code on
the Veltrix Security-as-Code platform. Author configuration in the Configuration
Canvas and drive it through the pipeline (validate → deploy → rollback →
health-check → drift-detect → status), with BYOL infrastructure provisioning
groundwork.

## How it's managed

Fleet exposes a single HTTPS **REST API** rooted at `/api/v1/fleet`. This app
applies all configuration over that API — there is no Salt/CLI path (unlike
Security Onion):

- **HTTPS REST (JSON)** — most config types (saved queries, policies, labels,
  teams, agent config, enroll secrets, global/MDM settings, calendar
  integrations, configuration profiles' batch endpoint, App Store/Fleet-
  maintained software) via `lib/fleetApi.ts`'s `getJson`/`sendJson`,
  authenticated with a Fleet **API token** (`Authorization: Bearer <token>`).
- **HTTPS REST (multipart/form-data)** — Scripts, since Fleet has no JSON path
  for uploading script content, via `lib/fleetApi.ts`'s `sendMultipart` (a
  small RFC 2388 encoder over `node:https`; no external dependency).

Self-signed certificates are tolerated (self-hosted Fleet, or the default 8080
listener).

## Configuration types

| Type | Surface | Group |
|---|---|---|
| **Saved Queries** | `/api/v1/fleet/queries` | Osquery |
| **Global Policies** | `/api/v1/fleet/global/policies` | Detections |
| **Labels** | `/api/v1/fleet/labels` | Detections |
| **Teams** | `/api/v1/fleet/teams` | Teams |
| **Agent Configuration** | `/api/v1/fleet/config` (`agent_options`) | Configuration |
| **Configuration Profiles** | `/api/v1/fleet/configuration_profiles/batch` | MDM |
| **Scripts** | `/api/v1/fleet/scripts` (multipart) | Scripts |
| **Software** | `/api/v1/fleet/software/fleet_maintained_apps`, `.../app_store_apps` | Software |
| **Enroll Secrets** | `/api/v1/fleet/spec/enroll_secret`, `/api/v1/fleet/fleets/{id}/secrets` | Enrollment |
| **Global Settings** | `/api/v1/fleet/config` (non-secret slice) | Configuration |
| **MDM Settings** | `/api/v1/fleet/config`, `/api/v1/fleet/fleets/{id}` (`mdm` block) | MDM |
| **Calendar Integrations** | `/api/v1/fleet/fleets/{id}` (`integrations.google_calendar`) | Integrations |

See **Coverage** below for the audited detail behind each row, plus what was
deliberately left out.

## BYOL infrastructure

`infra/spec.ts` declares a Fleet stack (`fleet-server` / `database` (MySQL) /
`redis` / `standalone`) as a declarative `InfraSpec` composed from the generic
OpenTofu modules — no tool-specific HCL. The generic provisioning worker runs
`infra/bringup/fleet-setup.mjs` (fleetctl / server setup) after `tofu apply`,
gating readiness on `/healthz` and a successful DB migration.

## Notes

Fleet API paths and request/response shapes follow the documented fleetdm
conventions; **verify against your live Fleet (fleetdm) instance**. The API token
is an API-only user token (or a session token from `POST /api/v1/fleet/login`).

Fleet's own REST API documentation is itself mid-transition, renaming "team" to
"fleet" in newer endpoints (Scripts, Software, Configuration Profiles use a
`fleet_id` parameter; some worked examples for Software still show `team_id`
instead of the parameter table's documented `fleet_id` — see **Coverage** for
exactly where this app hedges by sending both). The canvas fields in this app
are always named `teamId` regardless, to avoid confusion with this app's own
product name (also "Fleet").

## Development

```
cd apps/fleet
node node_modules/typescript/bin/tsc --noEmit    # typecheck
node ../../scripts/test-apps.mjs fleet           # run handler tests
node ../../scripts/validate-app.mjs apps/fleet   # validate against the app contract
```

## Coverage (v0.5.0)

Coverage was audited against the [Fleet REST API reference](https://fleetdm.com/docs/rest-api/rest-api)
and [fleetctl GitOps YAML reference](https://fleetdm.com/docs/using-fleet/gitops)
(`fleetdm/fleet` `docs/REST API/rest-api.md`, `main` branch, 2026-08-04).

### Managed declarative configuration

| Configuration type | Fleet REST API operations |
| --- | --- |
| Saved Queries | list/create/update(PATCH)/delete `/api/v1/fleet/queries`, upsert by name |
| Global Policies | list/create/update(PATCH)/delete `/api/v1/fleet/global/policies`, upsert by name |
| Labels | list/create/update(PATCH)/delete `/api/v1/fleet/labels`, upsert by name |
| Teams | list/create/update(PATCH)/delete `/api/v1/fleet/teams`, upsert by name (Fleet Premium) |
| Agent Configuration | `GET`/`PATCH /api/v1/fleet/config` (`agent_options` singleton) |
| Configuration Profiles | `GET /api/v1/fleet/configuration_profiles` (+ per-profile `alt=media` download) / `POST /api/v1/fleet/configuration_profiles/batch` — whole-list replace per team scope |
| Scripts | list/create/update(PATCH)/delete `/api/v1/fleet/scripts` (multipart), upsert by uploaded filename within a team scope |
| Software | list/create/update `/api/v1/fleet/software/fleet_maintained_apps` + `/api/v1/fleet/software/titles/{id}/package`; list/create/update `/api/v1/fleet/software/app_store_apps` + `/api/v1/fleet/software/titles/{id}/app_store_app`; delete `/api/v1/fleet/software/titles/{id}/available_for_install` |
| Enroll Secrets | `GET`/`POST /api/v1/fleet/spec/enroll_secret` (global); `GET`/`PATCH /api/v1/fleet/fleets/{id}/secrets` (team) — whole-list replace per scope |
| Global Settings | `GET`/`PATCH /api/v1/fleet/config` — `org_info`, `server_settings`, `features`, `host_expiry_settings`, `activity_expiry_settings`, `webhook_settings`, `fleet_desktop` only |
| MDM Settings | `GET`/`PATCH /api/v1/fleet/config` (global `mdm` block); `GET`/`PATCH /api/v1/fleet/fleets/{id}` (team `mdm` block, Fleet Premium) |
| Calendar Integrations | `GET`/`PATCH /api/v1/fleet/fleets/{id}` — `integrations.google_calendar` (per-team `enable_calendar_events` + `webhook_url` only) |

Every list-backed type is best-effort read-then-upsert (miss = new record) and
records the prior state per identity for rollback; the two whole-list-replace
types (Configuration Profiles, Enroll Secrets) snapshot the FULL prior list per
scope so rollback restores it exactly, the same shape Cisco Meraki's ordered
firewall-rule lists use.

### Notable implementation details, verified against the docs

- **Configuration Profiles** is the one resource with no per-item CRUD in
  Fleet's modern API — only a whole-list batch replace per team scope. Deploy
  therefore downloads every existing profile's content before overwriting a
  scope, so rollback can restore it byte-for-byte (decoded as UTF-8 — a
  binary-signed `.mobileconfig` authored outside this tool may not round-trip
  exactly; profiles this app authors are always plain-text XML/JSON).
- **Scripts** is the one config type that talks multipart/form-data — Fleet's
  Create/Update Script endpoints have no JSON alternative. `lib/fleetApi.ts`
  gained a small RFC 2388 encoder (`buildMultipartBody`/`sendMultipart`) for
  it; content over Fleet's 10,000-character ad hoc run-script limit is
  rejected at `validate` time.
- **Software**'s "Update package" endpoint is ALSO multipart/form-data, but
  the uploaded file itself is optional — this app calls it with only text
  fields (self-service, categories, install/post-install/pre-install scripts)
  to converge a Fleet-maintained app's overrides without ever handling a
  binary.
- **Software / Enroll Secrets team-scoping parameter naming is inconsistent
  in Fleet's own docs**: "Add Fleet-maintained app", "Add app store app",
  "Update app store app" and "Delete software" all document the parameter as
  `fleet_id` in their parameter table but show `team_id` in the worked
  example body/query. This app sends **both** keys on those four calls rather
  than guess — extra JSON/query keys a REST API doesn't use are ignored.
  Every other team-scoped endpoint (Configuration Profiles, Scripts, the
  Software list/read endpoints) is internally consistent and uses only
  `fleet_id`, so only `fleet_id` is sent there.
- **MDM Settings** applies to two different schemas: the global `mdm` block
  (`PATCH /config`) accepts several fields — Windows MDM enablement, Recovery
  Lock, Apple Silicon attestation, macOS migration — that the per-team `mdm`
  block (`PATCH /fleets/{id}`) does not document accepting; this app only
  sends those fields for the global scope (`teamId: "global"` on the canvas)
  and warns at `validate` time if they're set for a team.
- **Calendar Integrations** manages only the per-team, non-secret toggle
  (`enable_calendar_events` + `webhook_url`). Fleet's own docs disagree on
  whether `integrations.google_calendar` at the team level is an array (PATCH
  request schema) or a plain object (`GET /fleets/{id}` response example) —
  this app writes the array shape per the PATCH spec and reads back either
  shape defensively.
- **Enroll Secrets** is the one write-only-feeling type this app does NOT
  drop as secret material: unlike a third-party API credential, the enroll
  secret IS the declared resource, and Fleet returns it in plaintext on read
  — so, unusually for a `password`-typed field, drift detection here is a
  full value comparison, not just a presence check.

### Intentionally excluded

- **Custom uploaded software packages** (`.pkg`/`.msi`/`.exe`/`.deb`/`.rpm`/
  `.tar.gz`/`.ipa` installers, up to 10GB via `POST /software/package`) — a
  binary artifact upload does not fit this app's JSON/text canvas model the
  way a Fleet-maintained app or App Store reference (an id Fleet resolves
  itself) does. Managed Software here covers Fleet-maintained apps and App
  Store/VPP apps only.
- **Setup Experience** (`/setup_experience/*`: bootstrap package, custom MDM
  enrollment profile, EULA, setup scripts) — every one of these is a file
  upload (a `.pkg`, a signed `.mobileconfig`, a PDF, a script) with the same
  binary-artifact problem as custom packages, plus it configures a one-time
  enrollment WORKFLOW rather than steady-state device config.
- **Global Google Calendar integration** (`org_settings.integrations.
  google_calendar`: domain + a Google service-account API key JSON) — the API
  key is third-party credential material, not declarative config; configure
  it once out of band (Fleet UI or fleetctl gitops with the key in a secret
  manager). The per-team enable/webhook toggle that DEPENDS on it is managed
  by Calendar Integrations.
- **SMTP, SSO and third-party integrations** (`smtp_settings`, `sso_settings`,
  `integrations.jira`/`.zendesk`/`.google_workspace`) — every one carries a
  password, API token or IdP certificate/metadata as its primary content;
  Global Settings deliberately stops short of these sections.
- **Per-host live queries, MDM device commands, and script/query run
  results** (`POST /queries/run`, `POST /mdm/commands/run`,
  `GET /scripts/results/{id}`, `GET /queries/{id}/report`, host detail/
  activity/software-inventory endpoints) — these are one-off imperative
  actions or point-in-time observational data, not durable desired state a
  canvas declares.
- **Setup/host-scale device management** (per-host lock/unlock/wipe,
  Recovery Lock/passcode rotation, human-device mapping, host transfer) and
  **file carving** — imperative host operations, not configuration.
- **Users, sessions, SSO/SCIM identity, API-only user management,
  certificates/CAs, self-service categories, activities/audit log,
  vulnerabilities, targets, translator, debug and custom variables** — either
  security-sensitive control-plane administration (parallel to how this app's
  Fleet Premium teams stop at team CRUD, not user-role assignment), read-only
  observability, or ephemeral session state — not canvas configuration.

Primary reference: the [Fleet REST API reference](https://fleetdm.com/docs/rest-api/rest-api)
and each endpoint cited above; verify against your live Fleet (fleetdm)
instance and its exact version, since (as noted throughout) parts of this API
are still being renamed upstream.

Apache-2.0.
