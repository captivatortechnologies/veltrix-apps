# Splunk Cloud Platform (Veltrix App)

Manage Splunk Cloud Platform configuration as code through the **Admin Config
Service (ACS) API** — Splunk's supported administration API for Splunk Cloud
stacks. This app treats your indexes, HEC tokens, and IP allow lists as
versioned configuration flowing through the Veltrix pipeline: validate →
deploy → health check → drift detect → rollback.

Unlike the `splunk-enterprise` app (which talks to splunkd management ports
over your connectivity providers), Splunk Cloud is administered through the
public ACS endpoint — no tunnels or connectivity providers are required.

## Configuration types

| Type | What it manages | ACS endpoints |
|------|-----------------|---------------|
| `indexes` | Event/metric indexes: searchable retention, size caps, DDAA/DDSS archival | `GET/POST /indexes`, `GET/PATCH/DELETE /indexes/{name}` |
| `hec-tokens` | HTTP Event Collector tokens: default/allowed indexes, source/sourcetype, acknowledgement, enablement | `GET/POST /inputs/http-event-collectors`, `GET/PATCH/DELETE /inputs/http-event-collectors/{name}` |
| `ip-allowlists` | Per-feature IP allow lists (`search-api`, `hec`, `s2s`, `search-ui`, `idm-ui`, `idm-api`, `acs`) | `GET/POST/DELETE /access/{feature}/ipallowlists` |

All endpoints are relative to `https://admin.splunk.com/{stack}/adminconfig/v2`.

## Prerequisites

1. **A Splunk Cloud Platform stack** (Victoria or Classic Experience) with one
   or more search heads. ACS does not support single-instance deployments.
2. **A component** of type `splunk-cloud-stack` whose hostname is your stack
   name. Both `mystack` and `mystack.splunkcloud.com` work — the app strips
   the domain to derive the ACS stack name.
3. **An ACS authentication token (JWT)**:
   - Sign in to Splunk Web as a user with the `sc_admin` role (it has all
     capabilities required by the ACS endpoints this app uses).
   - Go to **Settings → Tokens** and create an authentication token.
   - Store the token value in a Veltrix credential's **API token** field and
     assign the credential to your stack component.
   - Tokens expire. For automated rotation, ACS exposes
     `POST /adminconfig/v2/tokens` (supports ephemeral tokens that expire
     after 6 hours — useful for CI/CD-style access).

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| `acs_base_url` | `https://admin.splunk.com` | Use `https://admin.splunkcloudgc.com` for FedRAMP Moderate (IL2) stacks |
| `experience` | `victoria` | Victoria or Classic. All three configuration types work on both; the value is recorded with deployments and gates future Victoria-only types (e.g. limits.conf) |
| `request_timeout_seconds` | `30` | Per-request timeout for ACS calls |

## Canvas model

Each canvas **section** describes one resource (one index, one HEC token, or
one feature's allow list). Add a section per resource.

### `indexes` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Lowercase letters, numbers, `_`, `-`; must begin with a letter or number; max 80 chars. Internal indexes (leading `_`) cannot be managed via ACS. |
| `datatype` | `event` (default) or `metric`. **Immutable** — ACS cannot change it after creation; a mismatch fails the deploy. |
| `searchableDays` | Positive integer. ACS default is 90 when omitted. Values above 3650 produce an entitlement warning. |
| `maxDataSizeMB` | Non-negative integer; `0` = unlimited (ACS default). Values above 1,000,000 produce a review warning. |
| `splunkArchivalRetentionDays` | Optional DDAA retention (counted from index creation, not rolling). Must be **greater than** `searchableDays` and at most 3650. |
| `selfStorageBucketPath` | Optional DDSS location (`s3://…` or `gs://…`). Mutually exclusive with DDAA. |

Deploy PATCHes existing indexes (only `searchableDays`, `maxDataSizeMB`,
`splunkArchivalRetentionDays`, `selfStorageBucketPath` are updatable via ACS)
and POSTs missing ones, then polls until provisioning completes (creation is
asynchronous — ACS returns 202 and the index GETs 404 until ready).

### `hec-tokens` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Letters, numbers, `_`, `-`; max 100 chars; unique per stack. |
| `defaultIndex` | Recommended. If omitted, ACS routes events to `default` — ensure that index exists or events are lost (validation warns). |
| `allowedIndexes` | Optional list. When set, must include the default index. |
| `defaultSource` / `defaultSourcetype` | Optional metadata defaults. |
| `useAck` | Indexer acknowledgement — currently only supported for AWS Kinesis Data Firehose (validation warns). |
| `disabled` | Deploy the token disabled. |

**Token values are secrets and never appear in a canvas** — ACS generates
them at creation time, and validation rejects any `token` field. Retrieve the
generated value from Splunk Web or `GET /inputs/http-event-collectors/{name}`.
Token creation is asynchronous (202 + poll), and the token *value* cannot be
changed after creation.

### `ip-allowlists` fields

| Field | Constraint |
|-------|-----------|
| `feature` | One of `search-api`, `hec`, `s2s`, `search-ui`, `idm-ui`, `idm-api`, `acs`. One section per feature. |
| `subnets` | IPv4 CIDR list (use `/32` for single hosts). Max 200 per feature (ACS limit; AWS additionally caps allow-list groups at 230 shared subnets). `0.0.0.0/0` is rejected; prefixes broader than `/8` warn. |
| `removeUndeclared` | When enabled, deploy removes live subnets not declared in the canvas (full reconcile). Otherwise deploy is additive. |

**Lockout protection:** the app never removes subnets from the `acs`
feature's allow list, even with `removeUndeclared` — deleting the wrong ACS
subnet can permanently lock you (and this app) out of the ACS API, requiring
Splunk Support to recover.

## Pipeline semantics

- **deploy** captures the prior state of every touched resource and returns
  it as `rollbackData`, including on partial failure, so rollback can revert
  exactly what was applied.
- **rollback** deletes resources the deployment created and PATCHes updated
  resources back to their captured prior values (for allow lists: removes
  added subnets, restores removed ones).
- **healthCheck** verifies ACS reachability/token validity plus per-resource
  existence (and enabled-state for HEC tokens); score = passed/total × 100.
- **driftDetect** GETs live state and diffs it against the deployed canvas.
  Missing resources and shortened retention are `critical`; changed managed
  fields are `warning`; metadata-only differences are `info`.

## Error handling and rate limits

- ACS errors are JSON bodies with `code`/`message` (e.g.
  `404-index-not-found`, `404-hec-not-found`, `409` conflicts,
  `424-failed-dependency`) — handler messages surface them verbatim.
- ACS enforces **600 requests per 10 minutes per stack** (HTTP 429 when
  exceeded). Deploys of very large canvases and frequent drift scans share
  this budget.

## Victoria vs Classic Experience

Indexes, HEC tokens, and IP allow lists are supported by ACS on **both**
experiences. Notable differences that affect future work: limits.conf
management and app permission/export endpoints are Victoria-only; private
app installs on Classic go through victoria/classic-specific app endpoints;
FedRAMP stacks use `https://admin.splunkcloudgc.com` (Classic only).

## Limitations (v1)

- IPv4 allow lists only (`ipallowlists-v6` is not yet managed).
- Indexes are never deleted by deploy — removal from a canvas leaves the
  index in place (deletion destroys data; rollback only deletes indexes the
  same deployment created).
- DDAA/DDSS cannot be disabled or switched via ACS — only via Splunk Web.
- No management of Splunk internal indexes (`_internal`, `_audit`, …).
- Async provisioning is polled for ~30 seconds; slower creations are
  reported as "still provisioning" and verified by the next health check.

## Future work

Natural next configuration types, all ACS-manageable:

- **Outbound ports** — `GET/POST /access/outbound-ports`,
  `GET/DELETE /access/outbound-ports/{port}`
- **Maintenance windows** — `GET/POST /maintenance-windows/schedules`,
  `GET/PATCH/DELETE /maintenance-windows/schedules/{scheduleID}`
- **App installation** (Splunkbase + private apps) —
  `GET/POST /apps/victoria`, `GET/PATCH/DELETE /apps/victoria/{app_name}`
- **Users, roles, capabilities** and **limits.conf** (Victoria only) —
  `/limits`, `/limits/{stanza}`

## Research sources

- [Manage indexes in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.1.2507/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-indexes-in-splunk-cloud-platform)
- [Manage HEC tokens in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.1.2507/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-http-event-collector-hec-tokens-in-splunk-cloud-platform)
- [Configure IP allow lists for Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.1.2507/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/configure-ip-allow-lists-for-splunk-cloud-platform)
- [Manage authentication tokens in Splunk Cloud Platform](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.2.2510/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-authentication-tokens-in-splunk-cloud-platform)
- [ACS API endpoint reference](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/admin-config-service-acs-api-endpoint-reference)
- [ACS requirements and compatibility matrix](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/9.3.2411/using-the-admin-config-service-acs--api/admin-config-service-acs-requirements-and-compatibility-matrix)
- [Troubleshoot ACS error messages](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.4.2604/troubleshoot-admin-config-service-acs-api/troubleshoot-acs-error-messages)
- [Manage Splunk Cloud Platform indexes (naming rules)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/10.1.2507/manage-your-indexes-and-data-in-splunk-cloud-platform/manage-splunk-cloud-platform-indexes)

## License

Apache-2.0
