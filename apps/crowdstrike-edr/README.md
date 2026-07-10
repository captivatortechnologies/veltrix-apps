# CrowdStrike Falcon (Veltrix App)

Manage CrowdStrike Falcon configuration as code through the **Falcon APIs**.
This app treats your host groups, prevention policies, and custom IOCs as
versioned configuration flowing through the Veltrix pipeline: validate →
deploy → health check → drift detect → rollback.

Falcon is administered through its public per-region API — no tunnels or
connectivity providers are required. Authentication is OAuth2
client-credentials (bearer tokens with a ~30-minute lifespan, renewed
automatically by the app's shared client).

## Configuration types

| Type | What it manages | Falcon endpoints |
|------|-----------------|------------------|
| `host-groups` | Host groups: static or dynamic membership via FQL assignment rules | `GET /devices/combined/host-groups/v1`, `POST/PATCH/DELETE /devices/entities/host-groups/v1` |
| `prevention-policies` | Prevention policies: platform, enablement, host group assignment, toggle + ML slider settings | `GET /policy/combined/prevention/v1`, `POST/PATCH/DELETE /policy/entities/prevention/v1`, `POST /policy/entities/prevention-actions/v1` |
| `custom-iocs` | Custom indicators of compromise (SHA-256/MD5 hashes, domains, IPv4/IPv6) with detect/prevent/allow actions | `GET /iocs/queries/indicators/v1`, `GET/POST/PATCH/DELETE /iocs/entities/indicators/v1` |

## Prerequisites

1. **A CrowdStrike Falcon tenant** on any cloud region (US-1, US-2, EU-1,
   US-GOV-1, US-GOV-2).
2. **A Falcon API client** — created in the Falcon console (requires the
   *Falcon Administrator* role) under **Support and resources → Resources and
   tools → API clients and keys**, with these scopes:
   - **Host groups** — Read & Write
   - **Prevention policies** — Read & Write
   - **IOC Management** — Read & Write

   The client secret is shown only once at creation — copy it immediately.
3. **A component** of type `falcon-tenant` whose hostname identifies the
   cloud region: a region alias (`us-1`, `us-2`, `eu-1`, `us-gov-1`,
   `us-gov-2`) or an API hostname (`api.us-2.crowdstrike.com`). Commercial
   clouds are auto-discovered via the `X-Cs-Region` token response header if
   the hostname doesn't name a region; **GovCloud tenants never auto-discover**
   and must be addressed explicitly.
4. **A credential** assigned to the component's tool: the API **client ID**
   in the `username` field and the **client secret** in the `API token` field.

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| `falcon_region` | `auto` | Fallback region when the component hostname doesn't name one. `auto` starts at US-1 and follows `X-Cs-Region`. Note: production deployments resolve the region from the component hostname — prefer encoding it there. |
| `request_timeout_seconds` | `30` | Per-request timeout for Falcon API calls |

## Canvas model

Each canvas **section** describes one resource (one host group, one policy,
or one indicator). Add a section per resource.

### `host-groups` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Unique per tenant; max 255 chars. |
| `groupType` | `dynamic` (default), `static`, or `staticByID` — case-sensitive and **immutable**; a mismatch on an existing group fails the deploy. |
| `assignmentRule` | Host-FQL expression, e.g. `platform_name:'Windows'+tags:'SensorGroupingTags/production'`. **Required for dynamic groups, forbidden for static groups.** |
| `description` | Optional. |

Static group **membership** is curated in the Falcon console (or via host
actions) — this app manages the group object itself, which is still the
building block that prevention policies and IOCs target.

### `prevention-policies` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Unique per platform; `platform_default` (the built-in default policy) is reserved and cannot be managed. |
| `platform` | `Windows`, `Mac`, or `Linux` — **immutable** after creation. |
| `enabled` | New Falcon policies always start disabled; deploy converges to this value via the enable/disable policy actions. |
| `hostGroups` | Host group IDs. Deploy converges assignments to **exactly** this list (attaches missing, detaches undeclared). |
| `settings` | JSON array of `{id, value}`. Toggles: `{"enabled": bool}`. ML sliders: `{"detection": LEVEL, "prevention": LEVEL}` with levels `DISABLED` < `CAUTIOUS` < `MODERATE` < `AGGRESSIVE` < `EXTRA_AGGRESSIVE`; prevention must not exceed detection. Setting IDs are per-platform (e.g. `NextGenAV`, `CloudAntiMalware`, `OnSensorMLSlider`, `SensorTamperingProtection`, …). Only declared settings are managed; all others keep their tenant values. |

**Precedence is not managed** (v1): Falcon applies the highest-precedence
policy when a host is in multiple assigned groups, and the precedence
endpoint requires listing *all* non-default policies per platform — unsafe to
automate from a partial view. Order policies in the Falcon console.

### `custom-iocs` fields

| Field | Constraint |
|-------|-----------|
| `type` | `sha256`, `md5`, `domain`, `ipv4`, `ipv6` — immutable; with `value`, forms the indicator's identity. |
| `value` | Format-checked per type (64/32 hex chars, valid DNS name, valid IP). Hashes and domains are normalized to lowercase. |
| `action` | `detect`, `prevent`, `no_action`, `allow`. **`prevent` and `allow` are hash-only** (API constraint). |
| `severity` | `informational` … `critical`. Ignored (warning) for `allow`/`no_action`. |
| `platforms` | Non-empty subset of `windows`, `mac`, `linux`. |
| `appliedGlobally` | When false, `hostGroups` (Falcon host group IDs) is required. |
| `expiration` | Optional ISO-8601 UTC timestamp; must be in the future. |

## Pipeline semantics

- **deploy** captures the prior state of every touched resource and returns
  it as `rollbackData`, including on partial failure, so rollback can revert
  exactly what was applied. Existing resources are found by identity (group
  name / policy name+platform / indicator type+value) and PATCHed; missing
  ones are POSTed.
- **rollback** deletes resources the deployment created (policies are
  disabled first — enabled policies cannot be deleted) and PATCHes updated
  resources back to their captured prior values, restoring policy enablement
  and host group assignments.
- **healthCheck** verifies API reachability + credential scopes plus
  per-resource existence (and enablement for policies); score =
  passed/total × 100.
- **driftDetect** reads live state and diffs it against the deployed canvas.
  Missing resources, changed assignment rules, enablement flips, and
  protection toggles that should be on but are off are `critical`; other
  managed-field changes are `warning`; descriptions are `info`.

## Error handling and rate limits

- Falcon responses use a `{ meta, resources, errors }` envelope; handler
  messages surface the API's `errors[].code/message` plus `meta.trace_id`
  (CrowdStrike support asks for the trace ID in API investigations).
- The API pool is roughly **6,000 requests/minute per tenant**, shared across
  all of the customer's API clients. On HTTP 429 the client waits for the
  `X-RateLimit-RetryAfter` epoch (bounded at 15 s) and retries once.
- OAuth2 tokens (~30 min TTL) are cached and reused across handlers; 401s
  trigger one re-authentication.

## Cloud regions

| Region | Base URL |
|--------|----------|
| US-1 | `https://api.crowdstrike.com` |
| US-2 | `https://api.us-2.crowdstrike.com` |
| EU-1 | `https://api.eu-1.crowdstrike.com` |
| US-GOV-1 | `https://api.laggar.gcw.crowdstrike.com` |
| US-GOV-2 | `https://api.us-gov-2.crowdstrike.mil` |

## Limitations (v1)

- **Policy name matching:** Falcon's exact-match name filter silently returns
  empty for most custom policy names, so the app uses the documented
  contains-match (`name:~'…'`) and pins the exact name client-side. Renaming
  a policy in the Falcon console orphans it from the canvas (drift reports it
  missing).
- Static host group membership (add/remove hosts) is not managed.
- Prevention policy **precedence** is not managed (see above).
- Mobile platforms (iOS/Android) and rule-group attachment on policies are
  not managed.
- Resources are never deleted by deploy — removal from a canvas leaves the
  live object in place (rollback only deletes what the same deployment
  created).
- An IOC's `expiration` and `tags` are managed only while set on the canvas:
  blanking them stops managing the live values rather than clearing them
  (the API has no verified clear semantics; delete and recreate the
  indicator to remove an expiration). Host group and policy descriptions
  ARE fully converged — blanking one on the canvas clears it live.
- Detection/alert ingestion is out of scope for configuration management;
  see Future work.

## Future work

Natural next configuration types, all API-manageable with the same client:

- **Sensor update policies** (`/policy/entities/sensor-update/v2`) — sensor
  version pinning and uninstall protection
- **Exclusions** — ML exclusions (`/policy/entities/ml-exclusions/v1`),
  sensor-visibility and IOA exclusions
- **Response policies** (`/policy/entities/response/v1`)
- **Alert polling / Case Management integration** — the Alerts API
  (`/alerts/queries/alerts/v2`, filter `product:'epp'`) replaced the Detects
  API (decommissioned Sept 2025); Case Management (`/cases/`, `/casemgmt/`)
  replaced the Incidents API (decommissioned March 2026). Any future
  detection-ingest feature must build on these, not the legacy surfaces.

## Research sources

- [OAuth2 token API](https://developer.crowdstrike.com/api-reference/collections/oauth2/)
- [Host Group API collection](https://developer.crowdstrike.com/api-reference/collections/host-group/)
- [Prevention Policy API collection](https://developer.crowdstrike.com/api-reference/collections/prevention-policy/)
- [IOC Management API collection](https://developer.crowdstrike.com/api-reference/collections/ioc/)
- [Falcon Query Language reference](https://developer.crowdstrike.com/api-reference/falcon-query-language/)
- [FalconPy SDK](https://github.com/CrowdStrike/falconpy) (endpoint definitions and samples)
- [Official CrowdStrike Terraform provider](https://github.com/CrowdStrike/terraform-provider-crowdstrike) (prevention policy settings model, lifecycle ordering)
- [falcon-mcp](https://github.com/CrowdStrike/falcon-mcp) (FQL filter guides per collection)

## License

Apache-2.0
