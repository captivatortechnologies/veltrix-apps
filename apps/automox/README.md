# Automox

Manage [Automox](https://www.automox.com/) (cloud-native endpoint patch management) configuration as
code through the Automox Console API. Author configurations in the platform's Configuration Canvas and
deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback are handled per configuration type.

## Credentials

The app authenticates every request with a Bearer **API key**, and scopes almost every request to a
numeric **Organization ID** sent as the `o` query parameter.

| Veltrix credential field | Automox value |
| --- | --- |
| Username | Organization ID — numeric, **required** (e.g. `9999`) |
| API key (API token) | An Automox API key (Console: Settings > API Keys) |

The API endpoint is **fixed** — Automox is a single global console:

- `https://console.automox.com/api`

Saving a connection registers an **`automox-org`** deploy target automatically; no host to configure.

## What it manages

| Configuration type | Sidebar group | Automox object | API |
| --- | --- | --- | --- |
| Policies | Policies | Patch policies (`policy_type_name: patch`) | `/policies` |
| Worklets | Policies | Custom (Worklet) and Required Software policies | `/policies` |
| Server Groups | Groups | Server (device) Groups | `/servergroups` |

`Policies` and `Worklets` both reconcile the same underlying `/policies` collection but are
**independent config types** — each matches live objects by name **scoped to its own
`policy_type_name`** (see `config-types/lib/automoxPolicies.ts::findPolicyByName`), so a `patch` policy
and a `custom`/`required_software` policy that happen to share a name are never confused with each other.

### Policies (patch)

One canvas item = one patch Policy, matched on its **name**. Modeled in full: schedule
(days/time/weeks-of-month/months, converted from a day-of-week picker to Automox's bitmask fields),
patch rule (All / Filter / Manual / Advanced), filter type (Include / Exclude / Patch by Severity) with
filter patterns or severities, notification toggles, and optional JSON device-targeting filters.

### Worklets

One canvas item = one Custom (Worklet) or Required Software policy, matched on its **name** (scoped to
its own type).

- **Custom (Worklet)** — `auto_reboot` (required), `notify_reboot_user`, `os_family` (Windows/Mac/Linux),
  `missed_patch_window`, `evaluation_code` (required — the compliance-check script) and
  `remediation_code` (optional).
- **Required Software** — `package_name`, `package_version`, `installation_code` (all required),
  `os_family`, `missed_patch_window`. Optional `evaluation_code`/`remediation_code` overrides are
  **FLAGGED** — not in the documented schema properties for this policy type, but present (as `null`)
  in Automox's own official example payload.

Both types also support device-targeting filters (verified present on both configuration schemas).

### Server Groups

One canvas item = one Server Group, matched on its **name**. `refresh_interval` (360-1440 minutes),
`parent_server_group_id` (**required by Automox for every group, including top-level ones** — use your
organization's Default Group id; this app does not auto-discover it), `ui_color`, `notes`,
`enable_os_auto_update` / `enable_wsus` (tri-state: keep each device's own setting / enable / disable —
matching Automox's nullable enforce flags), `wsus_server`, and linked Policy ids.

### Deploy mechanics (all three config types)

Each deploy:

- lists the collection (`GET /policies?o=<org>` or `GET /servergroups?o=<org>`, paged with
  `page`/`limit`) and matches an existing object by name (rename-safe: the id assigned on a prior
  deploy is tried first, by canvas item id, before falling back to a name match);
- updates an existing object with `PUT .../{id}?o=<org>` or creates a new one with
  `POST ...?o=<org>`;
- records each object's id per canvas item so a **rename** updates the same object in place instead of
  creating a duplicate, and records the prior body so rollback can restore an updated object or delete
  a created one.

**`POST /policies` returns `201` with an EMPTY body** (verified) — the new policy's id is not in the
response, so Policies/Worklets resolve it by listing the org's policies and matching the just-created
name, scoped to the item's own type (the list is name-ordered, not recency-ordered, so the **highest**
matching id — the newest — is used). **`POST /servergroups` returns `200` with the full created
object** — no such workaround is needed for Server Groups.

Two live-API behaviors — verified via the community Automox MCP server's workflow, not documented in
the published OpenAPI spec — are applied automatically for every Patch/Worklet policy so a deploy never
400s on them:

- `configuration.filter_type` is **required on every Patch policy**, regardless of `patch_rule` (forced
  to `"all"` for non-Filter rules) — Automox issue #206.
- `configuration.device_filters_enabled` must be **explicitly `true`** for a supplied `device_filters`
  list to take effect; the API silently ignores it otherwise.
- Automox also requires `schedule_weeks_of_month` and `schedule_months` to be set whenever
  `schedule_days` is non-zero. When left blank, this app auto-fills the "every week / every month"
  bitmasks (`62` / `8190`) rather than deploying a policy that never runs.

## Health check

Handlers probe `GET /policies?o=<org>&limit=1` / `GET /servergroups?o=<org>&limit=1` — a read that
proves the API key and Organization ID are valid before doing any work — then confirm each declared
object still exists in the org.

## Connectivity test

`GET /orgs` is the one Automox endpoint this app uses that does **not** require an Organization ID, so
it validates the Bearer API key on its own. When the key is valid, the returned org list is also used
to cross-check the configured Organization ID, surfacing a typo here rather than as an opaque
400/404 on the first deploy.

## Shared implementation

`Policies` and `Worklets` share one implementation of the `/policies` wire protocol rather than
duplicating it:

- `config-types/lib/automoxPolicies.ts` — types, list/get/create-id-resolution, the common policy
  envelope (name/schedule/server_groups/notes), schedule bitmask conversion, device-filter parsing, and
  rollback-state capture.
- `config-types/lib/canvasValues.ts` — generic canvas-value coercion (`readBool`/`strList`/`intList`/etc.).
- `config-types/lib/validation.ts` — shared name-identity and schedule/server-group validation.

`Server Groups` targets a different Automox resource (`/servergroups`) and is self-contained.

## Verify against a live Automox tenant

API facts were verified against the official OpenAPI description published in Automox's own
`automox-console-sdk-python` (swagger-codegen, MIT) and cross-checked against the community
`automox-mcp` server's live-tested policy workflow (Apache-2.0). The following are **FLAGGED** for
verification against a live tenant:

- `evaluation_code`/`remediation_code` on a **Required Software** policy — not in the documented
  `RequiredSoftwarePolicyConfiguration` properties list, but present in Automox's own official example
  payload; sent only when supplied.
- `PUT /policies/{id}` and `PUT /servergroups/{id}` response bodies beyond the documented status codes
  (`204` for `/servergroups`; the OpenAPI excerpt used did not fully document `/policies`' `PUT`
  response) — this app treats any 2xx as success.
- `schedule_weeks_of_month` / `schedule_months` bitmask bit order beyond the "all weeks" (`62`) / "all
  months" (`8190`) constants cited in the community MCP server.
- Automox's "Default Group ID" discovery mechanism for `parent_server_group_id` — this app requires the
  operator to supply it directly rather than guessing which live Server Group is the org's default.

### Evaluated and declined — a 3rd config type

`/users/{userId}/api_keys` (`POST`, create an API key for an existing Automox user) is the only other
writable, non-imperative surface in the spec, but it requires a pre-existing `userId` (there is no
`POST /users` — user provisioning isn't in the API) and is account/credential administration rather than
an endpoint-security policy — tangential to this app's Endpoint Management scope and a poor fit for
reconcile-by-identity Security-as-Code. `/servers` and `/servers/batch` are device-inventory/action
endpoints (move group, patch-now), `/data-extracts` triggers an export job, and `/orgs` is
account/billing settings — none are declarative policy state suited to this pipeline.

## References

- Automox Console API (OpenAPI, official — swagger-codegen Python SDK): <https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml>
- Automox Developer Portal: <https://developer.automox.com/> (redirects to <https://docs.automox.com/product/Developer/Developer_LP.htm>)
- Automox Console API reference (Swagger UI): <https://console.automox.com/api/docs#console-api/>
- Community Automox MCP server — live-tested policy workflow (issue #206, bitmask/device-filter behavior): <https://github.com/AutomoxCommunity/automox-mcp/blob/main/src/automox_mcp/workflows/policy_crud.py>
