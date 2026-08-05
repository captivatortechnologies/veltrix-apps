# CrowdStrike Falcon (Veltrix App)

Manage CrowdStrike Falcon configuration as code through the **Falcon APIs**.
This app treats Falcon's full configuration surface — endpoint policies,
exclusions, FileVantage, Cloud Security, Next-Gen SIEM, firewall, RTR assets,
IT Automation, Recon, Identity Protection, Platform Administration and MSSP /
Flight Control — as versioned configuration flowing through the Veltrix
pipeline: validate → deploy → health check → drift detect → rollback. See
**Coverage** below for the complete, audited list of all 44 configuration
types and the surfaces intentionally left unmanaged.

Falcon is administered through its public per-region API — no tunnels or
connectivity providers are required. Authentication is OAuth2
client-credentials (bearer tokens with a ~30-minute lifespan, renewed
automatically by the app's shared client).

## Configuration types (foundational three)

The three types this app shipped with — documented in full below with their
field-level canvas model. The remaining 41 types (added across five later
build phases) are listed with their endpoints in **Coverage**; their
per-field canvas schemas live in each type's `canvas.yaml`.

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
  see Coverage's "Intentionally excluded surfaces" below.

## Coverage (v1.13.2)

Re-verified against the current CrowdStrike Falcon API surface —
[developer.crowdstrike.com](https://developer.crowdstrike.com/api-reference/operations-by-collection/)'s
operations-by-collection index, the [FalconPy SDK](https://github.com/CrowdStrike/falconpy)
endpoint definitions, and the [official Terraform provider](https://github.com/CrowdStrike/terraform-provider-crowdstrike)
(fetched 2026-08-05) — to confirm this app's declarative write coverage,
built across five phases (v1.7.0 → v1.13.1), is complete. This pass added
**no new configuration type**: every genuinely declarative, round-trippable
write surface Falcon exposes is already managed. One candidate surface
(Falcon Fusion SOAR Workflows) was investigated and is documented below as
intentionally excluded, with the specific API limitation that rules it out.

### Managed declarative configuration (44 types, 14 sidebar groups)

| Sidebar group | Configuration type | Falcon API collection |
| --- | --- | --- |
| Host & Assets | Host Group | `/devices/{combined,entities}/host-groups/v1` |
| Endpoint Policies | Prevention Policy | `/policy/{combined,entities}/prevention/v1`, `/policy/entities/prevention-actions/v1` |
| Endpoint Policies | Sensor Update Policy | `/policy/{combined/sensor-update/v1,entities/sensor-update/v2}`, `/policy/entities/sensor-update-actions/v2` |
| Endpoint Policies | Response (RTR) Policy | `/policy/{combined,entities}/response/v1`, `/policy/entities/response-actions/v1` |
| Endpoint Policies | USB Device Control Policy | `/policy/{combined/device-control/v1,entities/device-control/v2}`, `/policy/entities/device-control-actions/v1` |
| Endpoint Policies | Content Update Policy | `/policy/{combined,entities}/content-update/v1`, `/policy/entities/content-update-actions/v1` |
| Endpoint Policies | Custom IOA Rule Group | `/ioarules/{combined,entities,queries}/rule-groups/v1`, `/ioarules/entities/rules/v1` |
| Indicators | Custom IOC | `/iocs/{queries,entities}/indicators/v1` |
| Exclusions | ML Exclusion | `/policy/{entities,queries}/ml-exclusions/v1` |
| Exclusions | IOA Exclusion | `/policy/{entities,queries}/ioa-exclusions/v1` |
| Exclusions | Sensor Visibility Exclusion | `/policy/{entities,queries}/sv-exclusions/v1` |
| File Integrity Monitoring | FileVantage Policy | `/filevantage/{entities,queries}/policies/v1`, `policies-host-groups`/`policies-rule-groups` |
| File Integrity Monitoring | FileVantage Rule Group | `/filevantage/{entities,queries}/rule-groups/v1`, `rule-groups-rules` |
| File Integrity Monitoring | FileVantage Scheduled Exclusion | `/filevantage/{entities,queries}/policy-scheduled-exclusions/v1` |
| Cloud Security | Custom Configuration (IOM) Rule | `/cloud-policies/{entities,queries}/rules/v1` |
| Cloud Security | Suppression Rule | `/cloud-policies/{entities,queries}/suppression-rules/v1` |
| Cloud Security | Rule Override | `/cloud-policies/{entities,queries}/rule-overrides/v1` |
| Cloud Security | Compliance Framework | `/cloud-policies/{entities,queries}/compliance/frameworks/v1` |
| Cloud Security | Compliance Control | `/cloud-policies/{entities,queries}/compliance/controls/v1`, `control-rule-assignments` |
| Cloud Security | Cloud Group | `/cloud-security/{entities,queries}/cloud-groups/v1` |
| Cloud Security | Account Registration (AWS/Azure/GCP) | `/cloud-connect-cspm-{aws,azure,gcp}/entities/account/v1` |
| Cloud Security | Image Assessment Policy | `/container-security/entities/image-assessment-policies/v1` |
| Cloud Security | Registry Connection | `/container-security/{entities,queries}/registries/v1` |
| Cloud Security | Kubernetes Admission (KAC) Policy | `/admission-control-policies/{entities,queries}/policies/v1` |
| Next-Gen SIEM | Correlation Rule | `/correlation-rules/{entities,queries}/rules/v1`, `rule-versions/publish/v1` |
| Next-Gen SIEM | Parser | `/ngsiem-content/{entities,queries}/parsers/v1` |
| Next-Gen SIEM | Saved Query | `/ngsiem-content/{entities,queries}/savedqueries/v1` (+ `savedqueries-template`, see note) |
| Next-Gen SIEM | Dashboard | `/ngsiem-content/{entities,queries}/dashboards/v1` (+ `dashboards-template`, see note) |
| Next-Gen SIEM | Lookup File | `/ngsiem-content/{entities/bulk-lookupfiles,entities/lookupfiles,queries/lookupfiles}/v1` |
| Next-Gen SIEM | Data Connection | `/ngsiem/{combined,entities}/connections/v1`, `connections/status/v1` |
| Firewall | Firewall Rule Group | `/fwmgr/{entities,queries}/rule-groups/v1` |
| Firewall | Firewall Policy | `/fwmgr/entities/policies/{v1,v2}` |
| Response & RTR | RTR Custom Script | `/real-time-response/{entities,queries}/scripts/v1` (multipart create/update) |
| Response & RTR | RTR Put-File | `/real-time-response/{entities,queries}/put-files/v1` (multipart create) |
| IT Automation | IT Automation Policy | `/it-automation/{entities,queries}/policies/v1`, `policies-host-groups` |
| IT Automation | IT Automation Task | `/it-automation/{entities,queries}/tasks/v1` |
| IT Automation | IT Automation Scheduled Task | `/it-automation/{entities,queries}/scheduled-tasks/v1` |
| Counter Adversary Ops | Recon Monitoring Rule | `/recon/{entities,queries}/rules/v1`, `/recon/{entities,queries}/actions/v1` |
| Platform Administration | Installation Token | `/installation-tokens/{entities,queries}/tokens/v1` |
| Platform Administration | User | `/user-management/entities/users/v1`, `/user-management/combined/user-roles/v2`, `user-role-actions/v1` |
| Identity Protection | IDP Policy Rule | `/identity-protection/{entities,queries}/policy-rules/v1` |
| MSSP / Flight Control | CID Group | `/mssp/{entities/cid-groups/v1,entities/cid-groups/v2,queries/cid-groups/v1}`, `cid-group-members` |
| MSSP / Flight Control | User Group | `/mssp/{entities/user-groups/v1,entities/user-groups/v2,queries/user-groups/v1}`, `user-group-members` |
| MSSP / Flight Control | Role Mapping | `/mssp/{entities,queries}/mssp-roles/v1` |

**Note — NG-SIEM Saved Queries / Dashboards:** create/update ride a
multipart `application/x-yaml` `yaml_template` upload (a `savedqueries-template`
/ `dashboards-template` form field), not a JSON body. `FalconClient.requestMultipart`
supports the transport since v1.12.1, but the exact template schema and the
`search_domain` value are still unconfirmed against a live tenant (flagged
in-code) — read, drift, health check, and rollback are unaffected.

### Intentionally excluded surfaces

- **Falcon Fusion SOAR Workflows** (`/workflows/entities/definitions/{import,v1}`,
  `export/v1`) — investigated as the one plausible remaining gap: CrowdStrike
  does expose `search_definitions`/`export_definition`/`import_definition`/
  `update_definition`. But `WorkflowDefinitionsImport` (the create path) is a
  multipart `application/x-yaml` upload of Fusion's internal
  trigger/condition/action DSL — a definition must be produced by the visual
  workflow builder or `export_definition`'d from an existing workflow first;
  CrowdStrike documents no schema for hand-authoring one from scratch. This is
  the same class of blocker already flagged unresolved for this app's own
  `ngsiem-saved-queries`/`ngsiem-dashboards` `yaml_template` uploads (see note
  above) — deferred for the same reason, pending a live-tenant-confirmed schema.
  ([Workflows collection](https://developer.crowdstrike.com/api-reference/collections/workflows/),
  [FalconPy `import_definition`](https://github.com/CrowdStrike/falconpy/blob/main/src/falconpy/workflows.py))
- **Real Time Response session commands ("one-shot" actions).** RTR session
  init + `active-responder-command` / `admin-command` execution (run, get,
  put, cp, mv, rm, netstat, ps, kill — single-host or batch) act on a live
  host session; they are imperative commands, not a durable resource to
  converge. (Distinct from the reusable RTR *assets* this app does manage —
  Custom Scripts and Put-Files.)
  ([Real Time Response](https://developer.crowdstrike.com/api-reference/collections/real-time-response/),
  [Real Time Response Admin](https://developer.crowdstrike.com/api-reference/collections/real-time-response-admin/))
- **Host/device actions** (contain, lift containment, hide/unhide, tag) target
  specific live device IDs via a fleet-scale action endpoint, not a named
  resource this app's canvas model owns — the same boundary this catalog's
  `cisco-meraki` app draws around device-scale operations.
- **Detections / Incidents / Alerts / Case Management.** The legacy Detects
  API was decommissioned Sept 2025 (replaced by the Alerts API,
  `/alerts/queries/alerts/v2`) and the legacy Incidents API was decommissioned
  March 2026 (replaced by Case Management, `/cases/`, `/casemgmt/`). Both
  successors are triage/workflow state (assign, resolve, comment) — not
  durable declarative posture — so neither is a configuration-management
  target for this app.
- **Falcon Discover** (asset, application, and SaaS-application inventory) and
  **Falcon Spotlight** (vulnerability management) are query-only surfaces —
  CrowdStrike documents no create/update operation for either; they exist to
  be read, not converged.
- **Zero Trust Assessment** (`/zero-trust-assessment/entities/assessments/v1`)
  is a read-only per-host scoring surface with no configuration to write.
- **Sensor Download** (`/sensors/entities/download-installer/*`) downloads a
  signed installer binary by SHA-256/CCID — an artifact fetch, not
  configuration.
- **API Clients & Keys (OAuth2 client self-management).** Creating or rotating
  the very API client this app authenticates with is Falcon-console-only
  (**Support and resources → API Clients and Keys**, Falcon Administrator
  role) — CrowdStrike documents no public API operation for one OAuth2 client
  to provision another, a deliberate bootstrap-security boundary.
- **Policy precedence** (prevention, sensor update, response, device control)
  is not managed for any policy family: the precedence-set endpoint requires
  submitting the full ordered list of every non-default policy on the
  platform, which is unsafe to converge from a partial canvas view — order
  policies in the Falcon console (see Limitations above for prevention
  policies specifically).
- **Secret material is never round-tripped.** Where a managed type carries a
  secret (NG-SIEM Data Connection ingest credentials, FileVantage/RTR script
  contents once written, installation-token values), the value is accepted on
  write but never read back, diffed for drift, or restored on rollback —
  consistent with how every credential-bearing type in this app already
  documents itself.

## Research sources

- [OAuth2 token API](https://developer.crowdstrike.com/api-reference/collections/oauth2/)
- [Host Group API collection](https://developer.crowdstrike.com/api-reference/collections/host-group/)
- [Prevention Policy API collection](https://developer.crowdstrike.com/api-reference/collections/prevention-policy/)
- [IOC Management API collection](https://developer.crowdstrike.com/api-reference/collections/ioc/)
- [Falcon Query Language reference](https://developer.crowdstrike.com/api-reference/falcon-query-language/)
- [FalconPy SDK](https://github.com/CrowdStrike/falconpy) (endpoint definitions and samples)
- [Official CrowdStrike Terraform provider](https://github.com/CrowdStrike/terraform-provider-crowdstrike) (prevention policy settings model, lifecycle ordering)
- [falcon-mcp](https://github.com/CrowdStrike/falcon-mcp) (FQL filter guides per collection)
- [Operations by Collection index](https://developer.crowdstrike.com/api-reference/operations-by-collection/) (2026-08-05 full-surface coverage audit)
- [Workflows API collection](https://developer.crowdstrike.com/api-reference/collections/workflows/) and [FalconPy `workflows.py`](https://github.com/CrowdStrike/falconpy/blob/main/src/falconpy/workflows.py) (Fusion SOAR — investigated, excluded, see Coverage)
- [Real Time Response](https://developer.crowdstrike.com/api-reference/collections/real-time-response/) / [Real Time Response Admin](https://developer.crowdstrike.com/api-reference/collections/real-time-response-admin/) collections
- [Sensor Download](https://developer.crowdstrike.com/api-reference/collections/sensor-download/) and Zero Trust Assessment collections (read-only, excluded)

## License

Apache-2.0
