# VMware Carbon Black

Manage **VMware Carbon Black Cloud** configuration as code through the CBC API,
with validation, drift detection and rollback handled by the Veltrix
Security-as-Code pipeline.

## What it manages

| Configuration type | Carbon Black surface | Notes |
|---|---|---|
| **Reputation Overrides** | `/appservices/v6/orgs/{org_key}/reputations/overrides` | Allow/ban entries by SHA256 hash, signing certificate, or IT-tool path. |
| **Threat Feeds** | `/threathunter/feedmgr/v2/orgs/{org_key}/feeds` | Private threat feeds — a set of IOCs (hashes/domains/IPs) plus a single managed report. |
| **Watchlists** | `/threathunter/watchlistmgr/v3/orgs/{org_key}/watchlists` | Feed subscriptions (`classifier: feed_id`) with tagging/alerting. |
| **Feed Reports** | `/threathunter/feedmgr/v2/orgs/{org_key}/feeds/{feed_id}/reports` | Titled IOC groups nested inside a private threat feed. |
| **Policies** | `/policyservice/v1/orgs/{org_key}/policies` | Endpoint policies — name, priority level and a validated policy JSON body. |
| **Policy Rule Configs** | `/policyservice/v1/orgs/{org_key}/policies/{id}/rule_configs/core_prevention` | Core-prevention BLOCK/REPORT assignment, patched per named policy. |
| **Data Forwarders** | `/data_forwarder/v2/orgs/{org_key}/configs` | Event streams shipped to S3 / Azure Blob / GCS. |
| **Asset Groups** | `/asset_groups/v1/orgs/{org_key}/groups` | Dynamic (query-based) device groups with optional policy assignment. |
| **Device Control Approvals** | `/device_control/v3/orgs/{org_key}/approvals` | USB allow-list entries (vendor/product/serial natural key). |
| **Device Control Blocks** | `/device_control/v3/orgs/{org_key}/blocks` | Per-policy USB write/execute enforcement toggles. |
| **Watchlist Reports** | `/threathunter/watchlistmgr/v3/orgs/{org_key}/reports` | Shared IOC reports, referenceable by watchlists via `report_ids`. |
| **Access Grants (RBAC)** | `/access/v2/orgs/{org_key}/grants` | RBAC role grants to existing users, applied additively. |

Carbon Black reputation overrides have **no update API**, so the app matches a
declared override to a live one by its **natural key** — the override type plus
its identifying value (a SHA256 hash, a signing certificate, or an IT-tool path)
— and applies any change as **delete + recreate**. The original pre-management
state is carried forward across deploys so rollback can restore it. Reconcile
only deletes overrides this app created but no longer declares.

## Authentication

Carbon Black authenticates with an **API key** sent as
`X-Auth-Token: <API Secret Key>/<API ID>` (secret first). In **Settings > API
Access**, create a **Custom** access level granting `org.reputations`
CREATE/READ/DELETE, then an API key with it. Store the credential as:

- **Username** → the API ID
- **Password** → the API Secret Key

Set the region **Base URL** (e.g. `https://defense.conferdeploy.net`; EU/APAC
differ) and your **Org Key** in the app's settings.

The **Access Grants** configuration type additionally needs read access to
**Users** (to resolve a principal's email to its `login_id`) and permission to
manage **Grants** on the Access Profiles and Grants API — grant the key's own
role only the roles it needs to hand out (CBC enforces that a key cannot grant
a role beyond its own scope; `GET .../access/v3/orgs/{org_key}/principals/{token}/roles/permitted`
lists what a given key may manage).

## Configuration type: Reputation Overrides

Each canvas item is one override:

- **Label** — a friendly canvas identity (not sent to Carbon Black).
- **List** — `BLACK_LIST` (ban) or `WHITE_LIST` (allow).
- **Type** — `SHA256`, `CERT`, or `IT_TOOL`, with the matching identifier
  (SHA256 hash / signed-by + certificate authority / path).
- **Description** — optional.

## Configuration type: Access Grants (RBAC)

Each canvas item grants one or more roles to one existing Carbon Black user:

- **Principal Email** — an existing user's email; resolved read-only to a
  `login_id` via the Users API (`GET /appservices/v6/orgs/{org_key}/users`).
  This config type never creates, edits or deletes a user.
- **Roles** — one full role URN per line, e.g. `psc:role::SECOPS_ROLE_MANAGER`
  (built-in) or `psc:role:{org_key}:CUSTOM_ROLE` (custom). The exact form of a
  given role isn't guessable from its name alone, so the URN is authored
  verbatim rather than normalized from a bare name.

**Additive only.** Deploy reads the principal's current grant (if any),
**unions** the declared roles into it, and `PUT`s the merged set back — a role
granted directly in the CBC console, or by another integration, is never
stripped. Removing an item from the canvas revokes only the roles *this app*
granted for it (read-modify-write, never a full replace); the grant itself is
deleted only if this app created it from nothing and no roles remain
afterward. Drift detection is asymmetric to match: a declared role missing
from the live grant is reported, an extra live role never is.

A principal whose grant already uses the `profiles` shape (CBC's multi-org /
MSSP-scoped access model — mutually exclusive with `roles`) is left alone; the
deploy reports an error for that item rather than silently overwriting it.

## Coverage (v0.6.0)

Coverage was audited against the current `developer.carbonblack.com` API
reference (Platform, Endpoint Standard, Audit & Remediation, Enterprise EDR
and Workload categories, fetched 2026-08-05) to confirm the existing 11
configuration types are exhaustive against CBC's declarative write surface,
and to find any genuinely untapped ground.

### Managed declarative configuration

| Configuration type | CBC API |
| --- | --- |
| Reputation Overrides | Reputation Override API — `/appservices/v6/orgs/{org_key}/reputations/overrides` |
| Threat Feeds + Feed Reports | Feed Manager API — `/threathunter/feedmgr/v2/orgs/{org_key}/feeds[/{id}/reports]` |
| Watchlists + Watchlist Reports | Watchlist API — `/threathunter/watchlistmgr/v3/orgs/{org_key}/{watchlists,reports}` |
| Policies + Policy Rule Configs | Policy Service API — `/policyservice/v1/orgs/{org_key}/policies[/{id}/rule_configs/core_prevention]` |
| Data Forwarders | Data Forwarder API — `/data_forwarder/v2/orgs/{org_key}/configs` |
| Asset Groups | Asset Groups API — `/asset_groups/v1/orgs/{org_key}/groups` |
| Device Control Approvals + Blocks | Device Control API — `/device_control/v3/orgs/{org_key}/{approvals,blocks}` |
| **Access Grants (RBAC)** *(new in 0.6.0)* | Access Profiles and Grants API — `/access/v2/orgs/{org_key}/grants[/{principal_urn}]` |

### Intentionally excluded

- **Alerts — no notification-rule config exists.** The Alerts API
  (`/api/alerts/v7/orgs/{org_key}/...`) covers search/export/facet/histogram,
  workflow status (dismiss/reopen a threat), notes and tags — all either
  read-only telemetry or a workflow action on a live alert/threat, not a
  durable object to declare. There is **no** endpoint anywhere in the current
  reference for configuring an alert notification/webhook/email rule — this
  was a real gap worth checking for, and it genuinely does not exist as public
  API surface today.
- **User Management** (`/appservices/v6/orgs/{org_key}/users`) — user
  lifecycle (invite/create/update/delete) is identity/PII administration, not
  endpoint security configuration; consistent with how this platform's other
  apps (e.g. `sentinelone`, `tenable-vm`) draw the line between "grant roles to
  a user" (managed) and "manage the user account itself" (excluded). This app
  only *reads* Users, to resolve a grant's principal.
- **Access Grants `profiles` shape** (multi-org / MSSP-scoped access with
  per-org allow-lists and conditions) — mutually exclusive with the `roles`
  shape this app manages; out of scope for a single-org-scoped app. A
  principal already using `profiles` is left untouched (see above).
- **Sensor Update Services** (`/sensor_update_service/v3/orgs/{org_key}/jobs`)
  — creates a one-shot, asynchronous sensor-version rollout **job** against a
  device search filter; it is a fire-and-forget action with progress state,
  not a persistent policy to reconcile. Per-policy sensor/agent settings
  (auto-update, live-response toggles, etc.) are already declarative config
  and already managed — inside the **Policies** type's `policyJson` body
  (`sensor_settings[]`).
- **Live Response API** (`/appservices/v6/orgs/{org_key}/cblr/...`) — an
  interactive remote-shell session onto a live endpoint (get/put files, kill a
  process, registry edits). Purely imperative, no stable object to diff.
- **Threat Intel TAXII2 API** (`/api/threat-intel/v1/taxii2/feeds/collections`)
  — CBC acting as a **TAXII server** exposing its own fixed, `can_write: false`
  collections to external consumers. Entirely read-only; there is no
  subscription/registration resource to write.
- **Recommendation API** (`/recommendation/v1/orgs/{org_key}/recommendation`)
  — accept/reject workflow on system-generated reputation-override
  suggestions. The resulting override is already config-as-code via
  **Reputation Overrides**; the recommendation itself is a triage action, not
  a durable declared object.
- **Devices, Processes Search, Observations, Network Threat Metadata, Audit
  Logs, Job Service** — read-only inventory/telemetry/reference data or async
  job-status polling; nothing here is written by the caller as a persistent
  object.
- **Script Deobfuscation, Vulnerability Assessment `_actions` (dismiss/edit),
  Threat/Alert workflow** — one-off analyses or exception actions tied to a
  specific live finding, not org-wide declarative posture the way Reputation
  Overrides or Watchlist Reports are.
- **VMware Carbon Black Cloud Workload** (Appliance Service, CIS Benchmark,
  Public Cloud Account Management, Sensor Lifecycle Management, VM Workload
  Search — every "Workload APIs" category endpoint, all vCenter/`vcenters/
  {vcenter_uuid}`-scoped) — a separate licensed CBC product module for vSphere
  / public-cloud workload posture management, distinct from the Endpoint
  Standard / Enterprise EDR / Platform surface this app targets. The same
  product-boundary reasoning this platform's other multi-module apps use
  (e.g. `sentinelone`'s Ranger exclusion, `cortex-xdr`'s Cortex Cloud
  exclusion) to keep a security-posture app scoped to the product it actually
  authenticates against.

Primary reference: [Carbon Black Cloud API reference index](https://developer.carbonblack.com/reference/carbon-black-cloud/).

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs carbon-black

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/carbon-black
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
