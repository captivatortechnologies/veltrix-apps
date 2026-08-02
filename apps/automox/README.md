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

| Configuration type | Automox object | API |
| --- | --- | --- |
| Policies | Patch / Required Software / Custom (Worklet) policies | `/policies` |

### Policies

One canvas item = one Policy, matched on its **name** (the logical identity used for upsert and drift).
Each deploy:

- lists `GET /policies?o=<org>` (paged with `page`/`limit`) and matches by name (rename-safe: the
  policy id assigned on a prior deploy is tried first, by canvas item id, before falling back to a name
  match);
- updates an existing policy with `PUT /policies/{id}?o=<org>` or creates a new one with
  `POST /policies?o=<org>`;
- records each policy's id per canvas item so a **rename** updates the same policy in place instead of
  creating a duplicate, and records the prior body so rollback can restore an updated policy or delete
  a created one.

**Policy types** (`policy_type_name`):

- **Patch** — modeled in full: schedule (days/time/weeks-of-month/months, converted from a day-of-week
  picker to Automox's bitmask fields), patch rule (All / Filter / Manual / Advanced), filter type
  (Include / Exclude / Patch by Severity) with filter patterns or severities, notification toggles, and
  optional JSON device-targeting filters.
- **Required Software** / **Custom (Worklet)** — accepted with a raw `configuration` JSON object.
  **FLAGGED**: their configuration schemas (installer scripts for Required Software, Worklet code for
  Custom) are materially different from Patch and are **not modeled** in v0.1.0 — author the
  type-specific fields directly as JSON. See CHANGELOG.md.

Two live-API behaviors — verified via the community Automox MCP server's workflow, not documented in
the published OpenAPI spec — are applied automatically for every Patch policy so a deploy never 400s on
them:

- `configuration.filter_type` is **required on every Patch policy**, regardless of `patch_rule` (forced
  to `"all"` for non-Filter rules) — Automox issue #206.
- `configuration.device_filters_enabled` must be **explicitly `true`** for a supplied `device_filters`
  list to take effect; the API silently ignores it otherwise.
- Automox also requires `schedule_weeks_of_month` and `schedule_months` to be set whenever
  `schedule_days` is non-zero. When left blank, this app auto-fills the "every week / every month"
  bitmasks (`62` / `8190`) rather than deploying a policy that never runs.
- `POST /policies` returns **`201` with an empty body** — the new policy's id is not in the response.
  This app resolves it by listing the org's policies and matching the just-created name (the list is
  name-ordered, not recency-ordered, so the **highest** matching id — the newest — is used).

## Health check

Handlers probe `GET /policies?o=<org>&limit=1` — a read that proves the API key and Organization ID are
valid before doing any work — then confirm each declared policy still exists in the org.

## Connectivity test

`GET /orgs` is the one Automox endpoint this app uses that does **not** require an Organization ID, so
it validates the Bearer API key on its own. When the key is valid, the returned org list is also used
to cross-check the configured Organization ID, surfacing a typo here rather than as an opaque
400/404 on the first deploy.

## Verify against a live Automox tenant

API facts were verified against the official OpenAPI description published in Automox's own
`automox-console-sdk-python` (swagger-codegen, MIT) and cross-checked against the community
`automox-mcp` server's live-tested policy workflow (Apache-2.0). The following are **FLAGGED** for
verification against a live tenant:

- The exact `configuration` shape for **Required Software** and **Custom (Worklet)** policies beyond
  the documented example fields (`os_family`, `package_name`, `package_version`, `evaluation_code`,
  `remediation_code`, `installation_code` for Required Software) — this app passes the JSON through
  unvalidated for these two types.
- `PUT /policies/{id}` response body/status — the OpenAPI excerpt used did not fully document it; this
  app treats any 2xx as success, matching the documented `POST` (`201`) and `DELETE` (`204`) behavior.
- `schedule_weeks_of_month` / `schedule_months` bitmask bit order beyond the "all weeks" (`62`) / "all
  months" (`8190`) constants cited in the community MCP server — an operator overriding these two
  advanced fields should confirm the resulting schedule in the Automox Console.

## References

- Automox Console API (OpenAPI, official — swagger-codegen Python SDK): <https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml>
- Automox Developer Portal: <https://developer.automox.com/> (redirects to <https://docs.automox.com/product/Developer/Developer_LP.htm>)
- Automox Console API reference (Swagger UI): <https://console.automox.com/api/docs#console-api/>
- Community Automox MCP server — live-tested policy workflow (issue #206, bitmask/device-filter behavior): <https://github.com/AutomoxCommunity/automox-mcp/blob/main/src/automox_mcp/workflows/policy_crud.py>
