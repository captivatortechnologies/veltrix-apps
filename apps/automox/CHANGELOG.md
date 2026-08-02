# Changelog

All notable changes to the Automox app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-08-02

Two new configuration types, plus a refactor to keep every `/policies`-backed config type from
colliding, all verified against the same official OpenAPI spec used in 0.1.0
(`automox-console-sdk-python/specs/ax_console.yaml`), cross-checked against the community
`automox-mcp` server's live-tested workflow.

- **Worklets** config type — create / edit / delete Automox **Custom (Worklet)** and **Required
  Software** policies over the same `/policies` API as Policies (`GET/POST /policies`,
  `GET/PUT/DELETE /policies/{id}`), reconciled independently by name **scoped to their own
  `policy_type_name`** so this config type never adopts a same-named patch Policy (or vice versa).
  - **Custom (Worklet)** — fully modeled from `CustomPolicyConfiguration`: `auto_reboot` (required),
    `notify_reboot_user`, `os_family` (enum Windows/Mac/Linux), `missed_patch_window`,
    `evaluation_code` (required — the compliance-check script) and `remediation_code` (optional).
  - **Required Software** — fully modeled from `RequiredSoftwarePolicyConfiguration`: `package_name`,
    `package_version`, `installation_code` (all required), `os_family`, `missed_patch_window`. Also
    exposes optional `evaluation_code`/`remediation_code` overrides — **FLAGGED**: not in the
    documented schema `properties` for this policy type, but present (as `null`) in Automox's own
    official example payload; only sent when the operator supplies a value.
  - Device targeting (`device_filters` / `device_filters_enabled`) is supported for both types —
    verified present on both configuration schemas, not patch-only as assumed in 0.1.0.
  - Same schedule model, rename-safe id tracking, and "empty `POST` body → resolve id by name" handling
    as Policies (shared via the new `config-types/lib/automoxPolicies.ts`).
- **Server Groups** config type — create / edit / delete Automox Server Groups over
  `GET/POST /servergroups` and `GET/PUT/DELETE /servergroups/{id}` (`ServerGroupCreateOrUpdateRequest`):
  `name`, `refresh_interval` (360-1440 minutes), `parent_server_group_id` (required by Automox for
  every group — including top-level ones, via the org's Default Group id; this app does not
  auto-discover it), `ui_color`, `notes`, `enable_os_auto_update`/`enable_wsus` (tri-state:
  keep-device-setting / enable / disable, matching Automox's nullable enforce flags), `wsus_server`,
  and linked Policy ids. Unlike `POST /policies`, `POST /servergroups` returns the full created object
  (200) — no id-resolution workaround needed.
- **Refactor — `policies` is now patch-only.** The 0.1.0 raw-JSON passthrough for Required Software /
  Custom policies is removed from the `policies` config type; those types are now the properly modeled
  `worklets` config type above. Shared plumbing (types, list/get/create-id-resolution, the common
  envelope fields, schedule bitmasks, device-filter parsing, rollback capture) was extracted into
  `config-types/lib/automoxPolicies.ts`, `config-types/lib/canvasValues.ts` and
  `config-types/lib/validation.ts` so `policies` and `worklets` share one implementation of the
  `/policies` wire protocol instead of duplicating it.
- Config sidebar grouping: `policies` and `worklets` are both under **"Policies"**; `server-groups` is
  under **"Groups"**.
- **Evaluated a 3rd config type — declined.** `/users/{userId}/api_keys` (`POST`, create an API key for
  an existing Automox user) is the only other writable, non-imperative surface in the spec, but it
  requires a pre-existing `userId` (there is no `POST /users` — user provisioning isn't in the API), and
  it is account/credential administration rather than an endpoint-security policy — tangential to this
  app's Endpoint Management scope and a poor fit for reconcile-by-identity Security-as-Code. `/servers`
  and `/servers/batch` are device-inventory/action endpoints (move group, patch-now), `/data-extracts`
  triggers an export job, and `/orgs` is account/billing settings — none are declarative policy state.
  Two config types (extending the Policies surface) is the clean set for this wave.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Policies** config type — create / edit / delete Automox Policies over the Automox Console API
  (`GET/POST /policies`, `GET/PUT/DELETE /policies/{id}`), org-scoped via the `o` query parameter, with
  validate / deploy (upsert by name, rename-safe id tracking) / rollback (restore prior or delete
  created) / health-check / drift-detect / status.
  - **Patch** policies are modeled in full: schedule (day-of-week picker converted to Automox's
    `schedule_days`/`schedule_weeks_of_month`/`schedule_months` bitmasks, with the "every week / every
    month" defaults auto-filled when left blank), patch rule (All / Filter / Manual / Advanced), filter
    type (Include / Exclude / Patch by Severity), notification toggles, and optional JSON device
    targeting filters.
  - Two live-API behaviors verified via the community `automox-mcp` server (not in the published
    OpenAPI spec) are applied automatically: `configuration.filter_type` is forced on every Patch
    policy regardless of `patch_rule` (issue #206), and `configuration.device_filters_enabled` is set
    whenever `device_filters` are supplied (otherwise silently ignored by the API).
  - `POST /policies` returns `201` with an **empty body** (verified) — the created policy's id is
    resolved by listing the org's policies and matching the just-created name (highest id wins, since
    the list is name-ordered, not recency-ordered).
- **Connectivity test** against `GET /orgs` (the one endpoint used here that needs no Organization ID)
  using a Bearer API key, cross-checking the configured Organization ID against the orgs the key can see.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key + Org ID → credential →
  author), and Connections (wraps the SDK `ConnectionsManager` against the fixed Automox endpoint;
  saving a connection registers `automox-org` as a deploy target).

> **Dropped surface (v0.1.0) — Required Software and Custom (Worklet) policy schemas.** Per the task's
> guidance to start with the common Patch policy shape, **Required Software** and **Custom (Worklet)**
> policies are accepted with a raw `configuration` JSON object rather than a fully modeled canvas —
> their configuration shapes (installer scripts / Worklet code) are materially different from Patch and
> were out of scope for this release. See README.md for the example Required Software fields.
>
> **Verify against a live Automox tenant (FLAGGED):**
> - The exact `configuration` shape for Required Software / Custom policies beyond the documented
>   example fields.
> - `PUT /policies/{id}`'s response body/status (the OpenAPI excerpt used did not fully document it).
> - `schedule_weeks_of_month` / `schedule_months` bit order beyond the "all weeks" (62) / "all months"
>   (8190) constants used for auto-fill.
