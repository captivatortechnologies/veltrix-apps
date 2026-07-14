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
| `apps` | Private apps/add-ons authored as files, built to a `.spl`, vetted by AppInspect, installed via ACS | Victoria: `GET/POST /apps/victoria`, `GET/DELETE /apps/victoria/{app}` · Classic: `GET/POST /apps`, `GET/DELETE /apps/{app}` |

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
| `appinspect_max_wait_seconds` | `900` | How long to wait for AppInspect to finish vetting an app package before failing the deploy (`apps` only) |

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

### `apps` fields

One item = one private app/add-on. Splunk Cloud has **no route for arbitrary
REST config writes**, so an app is always BUILT from the files you author here —
there is no "install source" as there is on Splunk Enterprise.

| Field | Constraint |
|-------|-----------|
| `name` | Required. The app id: starts with a letter, then letters/digits/`.`/`_`/`-`, max 100 chars. It is the single top-level folder in the `.spl` and the `[package] id`. |
| `label` | 5–80 chars (`[ui] label`). Required by Splunk even for an invisible add-on. |
| `version` | 3-part semver. Must increase on every change — see the downgrade note below. |
| `author`, `description` | `[launcher]` fields. Description is single-line, max 200 chars. |
| `visibility` | `app` (`export = none`) or `global` (`export = system`) in `metadata/default.meta`. |
| `readRoles` / `writeRoles` | Default `*` / `admin` + `sc_admin`. **`writeRoles` must include `sc_admin`** — it is the Cloud administrator role, and AppInspect fails a package without it. |
| `exportedObjects` | Object types promoted to `export = system` individually. Preferred over global sharing. |
| `appFiles` | The packaged files: `default/*.conf`, `bin/` (mode 700), `lookups/`, `static/`, `lib/`, `README/`. |

`default/app.conf` and `metadata/default.meta` are **generated** from the fields
above — authoring them by hand has no effect. `local/` cannot be packaged: it is
the user-owned override layer that shadows `default/` and survives upgrades.

**The install flow.** Deploy performs exactly this sequence, and there is no
alternative on Splunk Cloud:

1. **Build** the `.spl` in memory (reproducible gzipped ustar tar with explicit
   unix modes; 128 MB ACS limit enforced).
2. **Log in to AppInspect** — `GET https://api.splunk.com/2.0/rest/login/splunk`
   with HTTP Basic using your **splunk.com account**, returning a JWT.
3. **Submit for vetting** — `POST https://appinspect.splunk.com/v1/app/validate`
   (multipart: `app_package` = the `.spl`, `included_tags` = `private_victoria`
   or `private_classic`), then poll `/v1/app/validate/status/{id}` to a terminal
   state and fetch `/v1/app/report/{id}`.
4. **Gate** — install proceeds **only if `failure == 0 && error == 0 &&
   manual_check == 0`**. Any `manual_check` finding means self-service install is
   **blocked entirely** and a Splunk Support case is the only route; deploy fails
   with the offending check names and messages.
5. **Install** — Victoria `POST /apps/victoria` with the **raw** `.tar.gz` bytes,
   `X-Splunk-Authorization: <appinspect JWT>`; Classic `POST /apps` with a
   multipart body carrying `token=<appinspect JWT>` and `package=@<file>`. Both
   require `ACS-Legal-Ack: Y`. Install is **async** (`"status": "uploaded"` means
   still installing), so deploy polls to the terminal `"installed"` state.

**Two tokens, two identities.** `apps` is the only configuration type in this app
that needs more than the ACS token:

| Purpose | Credential field | Used as |
|---------|------------------|---------|
| ACS (stack) | **API token** — the Splunk Cloud JWT (`sc_admin`) | `Authorization: Bearer` |
| AppInspect | **Username** + **Password** — a **splunk.com** account | HTTP Basic → JWT → `X-Splunk-Authorization` / multipart `token` |

If the splunk.com username/password are missing, deploy **fails** rather than
skipping vetting — an unvetted package cannot be installed on Cloud at all.

**Validation is stricter than on Enterprise.** `validate` never touches the
network but rejects, as errors, everything AppInspect would fail the package
for: `indexes.conf` (an add-on must *reference* an existing index — create it
with the `indexes` type), the Cloud conf deny list (`outputs.conf`,
`limits.conf`, `authentication.conf`, `authorize.conf`, `passwords.conf`, …), a
bare `[http]` stanza, banned input stanzas (TCP/UDP/splunktcp, every Windows
input), real-time searches, crons more frequent than every 5 minutes, `index=*`,
and write access that omits `sc_admin`. `web.conf` is allowed only for
`[endpoint:*]`/`[expose:*]`, `server.conf` only for `[shclustering]
conf_replication_include.*` and `[diag] EXCLUDE-*`.

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

### `apps` limitations

- **No downgrade.** ACS installs an upgrade in place, but going *back* to an
  older version requires **uninstall-then-install**, and uninstalling **destroys
  the app's `local/` directory** — every setting a user changed in Splunk Web,
  every generated credential. Rollback therefore uninstalls only apps the
  deployment itself *created*; an app it *upgraded* is reported for manual
  handling instead of being silently deleted.
- **`manual_check` blocks everything.** A package that trips even one AppInspect
  manual check cannot be self-installed through ACS by any means; Splunk Support
  must review and install it.
- Splunkbase apps are not installed by this type (it manages *private* apps);
  ACS supports them via `splunkbaseID` + `X-Splunkbase-Authorization`.
- Vetting is slow and rate-limited: every deploy of an app re-submits the package
  to AppInspect.

## Future work

Natural next configuration types, all ACS-manageable:

- **Outbound ports** — `GET/POST /access/outbound-ports`,
  `GET/DELETE /access/outbound-ports/{port}`
- **Maintenance windows** — `GET/POST /maintenance-windows/schedules`,
  `GET/PATCH/DELETE /maintenance-windows/schedules/{scheduleID}`
- **Splunkbase app installation** — `POST /apps/victoria` with `splunkbaseID`
  and an `X-Splunkbase-Authorization` token (the `apps` type covers private apps)
- **App permissions/export** (Victoria only) — `GET/PATCH /apps/victoria/{app}/permissions`
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
- [Manage private apps in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.1.2507/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-private-apps-in-splunk-cloud-platform)
- [Splunk AppInspect API reference](https://dev.splunk.com/enterprise/reference/appinspect/appinspectapiepref/)
- [Vet a private app for Splunk Cloud (AppInspect API)](https://dev.splunk.com/enterprise/docs/releaseapps/cloudvetting/)

## License

Apache-2.0
