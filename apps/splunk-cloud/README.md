# Splunk Cloud Platform (Veltrix App)

Manage Splunk Cloud Platform configuration as code, primarily through the
**Admin Config Service (ACS) API** — Splunk's supported administration API for
Splunk Cloud stacks. This app treats your indexes, HEC tokens, IP allow lists,
private apps and roles as versioned configuration flowing through the Veltrix
pipeline: validate → deploy → health check → drift detect → rollback.

It manages the **same objects** as the `splunk-enterprise` app. What differs is
*how* each one is applied — see [How Cloud differs from
Enterprise](#how-cloud-differs-from-enterprise).

## Configuration types

| Type | What it manages | API | Endpoints |
|------|-----------------|-----|-----------|
| `indexes` | Event/metric indexes: searchable retention, size caps, DDAA/DDSS archival | ACS | `GET/POST /indexes`, `GET/PATCH/DELETE /indexes/{name}` |
| `hec-tokens` | HTTP Event Collector tokens: default/allowed indexes, source/sourcetype, acknowledgement, enablement | ACS | `GET/POST /inputs/http-event-collectors`, `GET/PATCH/DELETE /inputs/http-event-collectors/{name}` |
| `ip-allowlists` | Per-feature IPv4 allow lists (`search-api`, `hec`, `s2s`, `search-ui`, `idm-ui`, `idm-api`, `acs`). Cloud-only — there is no Enterprise equivalent | ACS | `GET/POST/DELETE /access/{feature}/ipallowlists` |
| `ip-allowlists-v6` | The IPv6 counterpart — a **separate** ACS resource, not a variant of `ip-allowlists` (Splunk's own `terraform-provider-scp` models it as its own resource too) | ACS | `GET/POST/DELETE /access/{feature}/ipallowlists-v6` |
| `outbound-ports` | Outbound connectivity rules: destination subnets the stack may open connections to from a given port (e.g. 8089 for federated search / S2S) | ACS | `GET/POST /access/outbound-ports`, `DELETE /access/outbound-ports/{port}` |
| `outbound-ports-v6` | The IPv6 counterpart — a separate ACS resource | ACS | `GET/POST /access/outbound-ports-v6`, `DELETE /access/outbound-ports-v6/{port}` |
| `limits` | Editable `limits.conf` settings (`join`, `kv`, `pdf`, `scheduler`, `searchresults`, `spath`, `subsearch`) within ACS min/max bounds | ACS | `GET /limits`, `GET/POST /limits/{stanza}` |
| `maintenance-windows` | Customer change-freeze policy (a UTC date range holding Splunk- and/or customer-initiated changes). Splunk-scheduled windows are view-only | ACS | `GET/PUT /maintenance-windows/preferences`, `GET /maintenance-windows/schedules` |
| `ddss-self-storage` | Dynamic Data Self Storage locations: register customer-owned S3/GCS buckets for frozen index data (create-only) | ACS | `GET/POST /cloud-resources/self-storage-locations/buckets` |
| `app-permissions` | Per-app read/write role permissions (which roles can view/run vs. edit each installed app). Victoria-only | ACS | `GET /permissions/apps`, `GET/PATCH /permissions/apps/{app}` |
| `apps` | **Private** apps/add-ons authored as files, built to a `.spl`, vetted by AppInspect, installed via ACS. **This is also where every `.conf` file ships** | ACS + AppInspect | Victoria: `GET/POST /apps/victoria`, `GET/DELETE /apps/victoria/{app}` · Classic: `GET/POST /apps`, `GET/DELETE /apps/{app}` |
| `splunkbase-apps` | **Published** Splunkbase apps installed by catalog id — already vetted by Splunk, so no build/AppInspect step. A separate config type from `apps` (private) | ACS + Splunkbase | `GET/POST/PATCH/DELETE /apps/victoria?splunkbase=true` (Classic: `/apps?splunkbase=true`) |
| `roles` | Roles: capabilities, inherited roles, searchable indexes, search filters, quotas. Capabilities are picked from a live ACS lookup (`GET /capabilities`) regardless of transport | **REST** (default, unchanged) **or ACS** (opt-in per role, v1.12.0+ — see [Search-head targeting](#search-head-targeting-for-acs-native-roles)) | REST: `GET/POST /services/authorization/roles`, `GET/POST/DELETE /services/authorization/roles/{role}` · ACS: `GET/POST /adminconfig/v2/roles`, `GET/PATCH/DELETE /adminconfig/v2/roles/{role}` |
| `users` | User role assignment + attributes (roles, email, full name, default app, timezone) for existing users. Passwords out of scope | **REST** (this app does not use ACS's newer `/users` endpoint — see [Coverage](#coverage)) | `GET/POST /services/authentication/users/{user}` |
| `authentication-tokens` | Stack-wide token-auth settings (enablement, default expiration). ACS exposes only per-token CRUD (secrets) | **REST** | `GET/POST /services/admin/token-auth/tokens_auth` |
| `sso` | SAML SSO identity-provider config (entity ID, IdP SSO/SLO URLs, role/realName/mail attribute mappings). SAML-only; IdP cert uploaded via Splunk Web | **REST** (ACS has no SAML endpoint) | `GET/POST /services/authentication/providers/SAML/{name}` |

ACS endpoints are relative to `https://admin.splunk.com/{stack}/adminconfig/v2`.
REST endpoints are relative to `https://{stack}.splunkcloud.com:8089` — the
stack's own management port, with its own prerequisites and its own token (see
[`roles`](#roles-fields) below).

## How Cloud differs from Enterprise

Splunk Cloud manages the same objects as Splunk Enterprise. Splunk, not you,
runs the stack — and that changes only *how* a change is applied:

| Object | Enterprise applies it via | Cloud applies it via |
|--------|---------------------------|----------------------|
| Indexes | REST `/services/data/indexes` | **ACS** `/indexes` |
| HEC tokens | REST `/servicesNS/…/data/inputs/http` | **ACS** `/inputs/http-event-collectors` |
| Splunk apps (and all `.conf` files) | build a `.spl` → install | build a `.spl` → **AppInspect vetting** → ACS |
| Roles | REST `/services/authorization/roles` | **the same REST endpoint** by default, on the stack's port 8089 — or, opt-in, **ACS** `/adminconfig/v2/roles` (see [Search-head targeting](#search-head-targeting-for-acs-native-roles)) |
| IP allow lists | n/a (your network is yours) | **ACS** — Cloud-only |
| BYOL, versions, upgrades, access servers | Enterprise-only | **absent by design** — Splunk owns the infrastructure, the release train and the upgrade window, so there is nothing to model |

Three consequences worth internalizing:

1. **ACS is broader than a REST proxy, and still growing.** It covers indexes,
   HEC, IPv4/IPv6 allow lists, IPv4/IPv6 outbound ports, limits, maintenance
   windows, self storage, app permissions, private apps and Splunkbase apps.
   Historically identity (users, roles) was out of scope entirely; ACS has
   **since gained** `/adminconfig/v2/roles` and `/adminconfig/v2/users`
   (confirmed via Splunk's official `terraform-provider-scp`). As of v1.12.0
   this app uses the roles endpoint as an **opt-in transport** — see
   [Search-head targeting](#search-head-targeting-for-acs-native-roles) for
   why it is opt-in rather than a wholesale replacement, and
   [Coverage](#coverage) for why `users` stays REST-only.
2. **Apps are vetted, not just installed — unless they already were.** Every
   `.conf` file reaching a Cloud stack inside a *private* app must pass
   AppInspect with `failure == 0 && error == 0 && manual_check == 0`; a
   `manual_check` finding blocks self-service installation *entirely*. A
   *Splunkbase* app skips this step — Splunk already vetted it before
   publication — but still installs through the same ACS collection.
3. **Roles can reach the stack through EITHER door.** They cannot ship inside
   an app either way — `authorize.conf` is on Splunk Cloud's AppInspect deny
   list, so a package containing it fails vetting regardless of transport. The
   REST door (default) has prerequisites you must arrange (below); the ACS
   door (opt-in) trades those for a search-head-targeting concern instead —
   see [Search-head targeting](#search-head-targeting-for-acs-native-roles).

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
4. **For a `roles` item on the REST transport (the default)** — REST API
   access to the stack, which is *not* enabled by default:
   - **Splunk Support must open management port 8089** for your stack. There is
     no self-service way to do this; file a support case.
   - **Your egress IP must be on the stack's `search-api` IP allow list.**
     Manage it with this app's `ip-allowlists` configuration type — declare a
     `search-api` section containing the CIDR your Veltrix deployment egresses
     from, and deploy it *before* your first roles deploy.
   - **A Splunk authentication token** (Splunk Web → **Settings → Tokens**),
     sent as `Authorization: Bearer …` and stored in the credential's **API
     token** field. A Splunk Web token created by an `sc_admin` user authenticates
     *both* ACS and REST, which is why one credential field serves both. An
     **ephemeral token minted by ACS** (`POST /adminconfig/v2/tokens`) is an ACS
     stack token and does **not** authenticate the REST API — if you rotate that
     way, keep a separate credential for `roles`.
   - **Free-trial stacks cannot use the REST API at all.**
   - A role item with **Transport: ACS** needs NONE of the above — just the
     same ACS JWT already required for every other type in this app. It has
     its own concern instead: see
     [Search-head targeting](#search-head-targeting-for-acs-native-roles).
5. **For the `apps` and `splunkbase-apps` types only** — a splunk.com account,
   stored in the credential's **username** and **password** fields (the ACS
   JWT stays in **API token**):
   - `apps` uses it to authenticate to AppInspect (vetting a private package).
   - `splunkbase-apps` uses the SAME fields to authenticate to Splunkbase
     itself (`POST https://splunkbase.splunk.com/api/account:login`), since a
     splunk.com account is also a Splunkbase account. One credential serves
     both types, the same way one ACS token serves both ACS and REST above.

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| `acs_base_url` | `https://admin.splunk.com` | Use `https://admin.splunkcloudgc.com` for FedRAMP Moderate (IL2) stacks |
| `experience` | `victoria` | Victoria or Classic. All three configuration types work on both; the value is recorded with deployments and gates future Victoria-only types (e.g. limits.conf) |
| `request_timeout_seconds` | `30` | Per-request timeout for ACS calls |
| `appinspect_max_wait_seconds` | `900` | How long to wait for AppInspect to finish vetting an app package before failing the deploy (`apps` only) |

## Canvas model

Each canvas **section** describes one resource (one index, one HEC token, one
feature's allow list, one private app, one role). Add a section per resource.

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

### `ip-allowlists-v6` fields

A **separate ACS resource** from `ip-allowlists` (`ipallowlists-v6`, not a
variant) — Splunk's own `terraform-provider-scp` models it as its own resource
(`scp_ip_v6_allowlists`) for the same reason.

| Field | Constraint |
|-------|-----------|
| `feature` | Same seven features as `ip-allowlists`. One section per feature. |
| `subnets` | IPv6 CIDR list (use `/128` for single hosts). ACS does not publish an explicit subnet cap for this endpoint (unlike v4's documented 200); a very large list warns rather than blocks. `::/0` is rejected; prefixes broader than `/32` warn. |
| `removeUndeclared` | Same reconcile semantics as `ip-allowlists`, plus one v6-specific quirk (below). |

**Lockout protection** for the `acs` feature is identical to `ip-allowlists`.
**Cannot-empty-in-one-call quirk:** Splunk's `terraform-provider-scp` documents
that ACS rejects a request that would remove every subnet from a v6 allow list
at once — "keep at least one original subnet in the list." This app's deploy
handler enforces the same rule itself: if a reconcile would remove every live
subnet, one is held back and reported, and a second deploy (with nothing left
declared) finishes the removal.

### `outbound-ports-v6` fields

The IPv6 counterpart to `outbound-ports` — a separate ACS resource
(`/access/outbound-ports-v6`), same fields and reconcile model, IPv6 CIDR
destinations instead of IPv4 (`::/0` warns instead of erroring, prefixes
broader than `/32` warn).

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

### `splunkbase-apps` fields

One item = one **published** Splunkbase app — a different thing from `apps`
above (which builds and vets a *private* app you authored). No files, no
AppInspect: Splunk already vetted the package before publishing it.

| Field | Constraint |
|-------|-----------|
| `appName` | Required. The app's **technical id** (e.g. `SplunkforPaloAltoNetworks`), found on its Splunkbase listing. Used for describe/upgrade/uninstall after install — NOT the same as `splunkbaseId`. |
| `splunkbaseId` | Required. The numeric id in the app's Splunkbase URL (`splunkbase.splunk.com/app/<id>`). Used only at install/upgrade time. |
| `version` | Optional. Omit to always install the latest cloud-compatible, self-service version. |
| `licenseAck` | Required. The app's license URL from its Splunkbase listing — ACS refuses to install without acknowledging it (`ACS-Licensing-Ack` header). |

**Two tokens, two identities** — same shape as `apps`' AppInspect requirement:

| Purpose | Credential field | Used as |
|---------|------------------|---------|
| ACS (stack) | **API token** — the Splunk Cloud JWT (`sc_admin`) | `Authorization: Bearer` |
| Splunkbase | **Username** + **Password** — the SAME splunk.com account `apps` uses for AppInspect | Exchanged for a session id → `X-Splunkbase-Authorization` |

**Not every Splunkbase app is self-service installable.** ACS rejects an app
that requires Splunk's review; a Support case is then the only route —
`validate` surfaces this as a standing reminder, and a deploy-time rejection
names it. **No downgrade**, same as `apps`: ACS can only upgrade an installed
Splunkbase app, so `rollback` uninstalls only apps this deployment *created*;
one it *upgraded* is reported for manual handling.

### `roles` fields

One item = one role. Field keys are Splunk's own `authorize.conf` / REST
parameter names — and, not by accident, ACS's own JSON field names too (see
[Search-head targeting](#search-head-targeting-for-acs-native-roles) for the
one field that differs between the two transports on read). The role model is
**identical to Splunk Enterprise's** — only the transport differs.

| Field | Maps to | Constraint |
|-------|---------|-----------|
| `name` | `name` | Required. Lowercase letters, numbers, `_`, `-`; must begin with a letter or number; max 100 chars (Splunk rejects uppercase, spaces, colons, slashes). `sc_admin` and `splunk-system-role` are **reserved by Splunk Cloud** and rejected — inherit from them instead. Redefining a built-in (`admin`, `power`, `user`, …) warns. |
| `importedRoles` | `imported_roles` (REST) / `importedRoles` (ACS) | Roles whose capabilities, indexes and quotas are inherited. A role may not inherit from itself. |
| `capabilities` | `capabilities` | Capabilities granted directly. A live, searchable **remote-multiselect** backed by ACS's own grantable-capability list (`GET /adminconfig/v2/capabilities?grantableOnly=true`) — this is a pure ACS lookup, so it works even without the REST prerequisites below. Splunk Cloud exposes a **reduced** capability set versus Enterprise; a role with no capabilities *and* no inherited roles warns. |
| `srchIndexesAllowed` | `srchIndexesAllowed` | Searchable indexes; wildcards supported. `*` warns (least privilege). |
| `srchIndexesDefault` | `srchIndexesDefault` | Indexes searched when a query names none. Every entry must be covered by `srchIndexesAllowed` (wildcard-aware), or un-qualified searches silently return nothing — this is an **error**. |
| `srchFilter` | `srchFilter` | SPL fragment ANDed into every search the role runs — the primary row-level access control on Cloud. |
| `srchTimeWin` | `srchTimeWin` | Max search **span** a single search may cover, seconds. `-1` = unlimited. |
| `srchTimeEarliest` | `srchTimeEarliest` | Max **age** — how far back in time a search may reach, seconds before now. `-1` = unset (inherits), `0` = unlimited. Distinct from `srchTimeWin`. |
| `defaultApp` | `defaultApp` | App users with this role land in. |
| `srchJobsQuota`, `rtSrchJobsQuota`, `srchDiskQuota` | same | Per-user quotas. Non-negative integers. |
| `cumulativeSrchJobsQuota`, `cumulativeRTSrchJobsQuota` | same | Role-wide quotas across all its users. `0` = unlimited. |
| `transport` | — (selects the API) | `rest` (default, blank = rest) or `acs`. See [Search-head targeting](#search-head-targeting-for-acs-native-roles). |
| `searchHeadTargets` | — (ACS URL path, not a JSON field) | ACS only. Zero or more search-head-cluster member instance ids (e.g. `sh-i-0910d0dfdb9ed913a`). Ignored on the REST transport. |

A field left blank on the canvas is **not sent**, so the role keeps whatever it
inherits or already has — this app only manages what the canvas declares.

**Failures name the prerequisites.** Because a closed port 8089 and a missing
`search-api` allow-list entry both surface as an opaque connection error,
`deploy`, `rollback` and `healthCheck` never report a bare "fetch failed": every
connection failure is rewritten to name both prerequisites, a 401 says the
Splunk token (not the ACS token) was rejected, and a 403 names the capability
required (`edit_roles` / `edit_roles_grantable`; `sc_admin` has it). `healthCheck`'s
first check *is* the reachability probe, so it is the fastest way to confirm
Support has opened the port and your IP is allow-listed.

### Search-head targeting for ACS-native roles

This is the design this app's 1.11.0 "Future work" note deferred, done as its
own dedicated pass. It only matters if you set a role's **Transport** to
`ACS` — the default (`REST`, or the field left blank) is unaffected.

**Why REST "just works" across a cluster and ACS does not.** A production
Splunk Cloud stack is a search head cluster (SHC); ACS itself "does not
support single-instance deployments." REST writes to
`/services/authorization/roles` land on Splunk's classic configuration
replication mechanism — the same one Splunk Enterprise SHCs use — which
propagates a role/user change to every cluster member automatically. ACS's
native identity endpoints are a newer, separate surface that Splunk did **not**
wire into that replication: its own docs state plainly that role/user writes
"apply only on the search head on which you create them. ACS does not
replicate users and roles across the search tier." An untargeted ACS request
lands on "the first standard search head or search head cluster" — whichever
member ACS happens to route it to, not necessarily the one you expect, and
never *every* member.

**How ACS expects you to target a specific member.** There is no separate
request parameter or header for this. Instead, the STACK PATH SEGMENT itself
changes: prefix it with that member's instance id and a literal dot —

```
https://admin.splunk.com/{stack}/adminconfig/v2/roles                         (default/untargeted)
https://admin.splunk.com/sh-i-0910d0dfdb9ed913a.{stack}/adminconfig/v2/roles   (one specific member)
```

— and the bearer token used for a targeted request must have been minted ON
that member (a token from the default member does not authenticate a
targeted one). This is confirmed against Splunk's own client, not just prose:
`terraform-provider-scp`'s generated ACS client (`acs/v2/api.gen.go`) treats
the stack as a bare string interpolated directly into the URL path
(`fmt.Sprintf("/%s/adminconfig/v2/roles", pathParam0)`), and its
`TargetStackName` helper (`internal/utils/utils.go`) builds exactly this
`"<target>.<stack>"` string; the provider's own docs
(`docs/index.md#targeting-a-search-head`) show the identical pattern via a
second, aliased `provider "scp" { stack = "sh-i-....<stack>" }` block, used to
manage "certain resources on specific search heads."

**There is no ACS endpoint to enumerate a stack's search-head-cluster
members.** The full generated ACS OpenAPI client (`acs/v2/api.gen.go`, ~15,000
lines) was searched end to end for this pass: no "member", "instance", "search
head" or "SHC" field or endpoint exists anywhere in it. `GET
/adminconfig/v2/status` (the client's `DescribeStack`) answers only with
stack-wide infrastructure/restart status, not a member list. A member's
instance id is therefore something you already know from your own deployment
(Splunk Web instance info, or a Support case) — this app cannot discover or
validate it against ACS.

**The design this app implements.** A role item's **Search Head Targets**
field (ACS transport only) is a free-text list of instance ids — not a live
picker, unlike every other object-reference field this app backs with an ACS
lookup, precisely because no such lookup exists for this one. `deploy`,
`rollback`, `driftDetect` and `healthCheck` all resolve it the same way:

| Declared targets | Behavior |
|-------------------|----------|
| *(empty)* | One write, to ACS's own default/untargeted stack path. `validate` warns (`untargeted_acs_write`) that this reaches exactly one search head, not the whole cluster. |
| `["sh-i-aaa"]` | One write, to that member specifically. |
| `["sh-i-aaa", "sh-i-bbb"]` | **One write per target**, sequentially — this role is applied to each named member. `driftDetect`/`healthCheck` report each target's result separately, so a role present on one member and missing on another is a visible, attributable finding rather than a blind spot. |

**Why this lives on the role item, not the component or a connectivity
provider.** The platform models a `splunk-cloud-stack` component as ONE stack
(one hostname / one JWT credential) — not a fleet of its individual search
heads, and there is nothing to enumerate them against (see above). A new
component type or connectivity provider per search head would invent
platform-graph machinery for something Splunk itself exposes as an opaque,
customer-supplied string — this app's existing precedent for exactly that
situation is a plain canvas field (e.g. `ddss-self-storage`'s
`selfStorageBucketPath`, `splunkbase-apps`' `licenseAck` URL), not a new
first-class object. A per-item field also lets different roles in the SAME
canvas use different transports and different targets — strictly more
flexible than Terraform's own model, where targeting is a whole aliased
provider block per stack, not per resource.

**Why REST stays the default rather than ACS.** REST already reaches every
cluster member with zero configuration, via Splunk's own replication — that is
categorically safer behavior for a role, a privilege-bearing object, to
default to. ACS is opt-in specifically so that choosing it is a deliberate,
informed decision (`validate`'s warning names the exact tradeoff), not a
silent regression triggered by an app upgrade.

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
- Vetting is slow and rate-limited: every deploy of an app re-submits the package
  to AppInspect.

### `splunkbase-apps` limitations

- **No downgrade**, same reasoning as `apps`: ACS upgrades an installed
  Splunkbase app in place but cannot revert it, so `rollback` only uninstalls
  apps this deployment *created*.
- **Not every app is self-service.** An app that needs Splunk's review cannot
  be installed through ACS by any means; a Support case is the only route.
- The **license acknowledgement URL** must be found manually on the app's
  Splunkbase listing — ACS validates it is *provided*, not that it is the
  *correct* URL for that specific app; a wrong URL surfaces as an ACS rejection
  at deploy time.

### `roles` limitations

- **REST transport (default) is not self-service.** Port 8089 stays closed
  until Splunk Support opens it, and the caller's IP must be on the
  `search-api` allow list. Both are prerequisites this app can *tell* you
  about (and, for the allow list, *manage*) but cannot grant. **Free-trial
  stacks cannot use the REST API at all**, so a REST-transport role cannot be
  deployed to one.
- **ACS transport (opt-in) does not replicate across a search head cluster**
  — see [Search-head targeting](#search-head-targeting-for-acs-native-roles).
  An ACS role with no declared targets reaches exactly one search head, not
  the whole cluster; `validate` warns when this is the case.
- Roles are **never deleted by deploy** on either transport — removing a role
  from the canvas leaves it on the stack (rollback only deletes roles the same
  deployment created, per declared target on the ACS transport).
- User-to-role assignment is a **separate** configuration type (`users`,
  REST-only — see [Coverage](#coverage)) — declaring a role here does not
  assign anyone to it.
- Splunk Cloud exposes a **reduced capability set** versus Enterprise. The live
  Capabilities picker narrows this in practice, but validation still only
  checks capability *syntax* for free-typed values — an unknown capability is
  rejected by the stack at deploy time, with Splunk's own message surfaced
  verbatim.

## Future work

- **Consider an ACS-native `users` transport IF ACS ever adds a timezone
  field.** As of this pass, `/adminconfig/v2/users` has no equivalent to this
  type's `tz` attribute — see [Coverage](#coverage) for the full evaluation.
  `authentication-tokens` and `sso` have no ACS equivalent found at all and
  would stay on REST regardless.
- **Enterprise Managed Encryption Keys (EMEK)** — deliberately excluded (see
  [Coverage](#coverage)): a Splunk-account-rep-gated feature whose key upload
  still needs a manual Splunk Support step to actually take effect, with no
  supported rotation via ACS at all.
- **Python runtime version** (`/adminconfig/v2/python-runtime`) — deliberately
  excluded (see [Coverage](#coverage)): a legacy Python-2-era migration switch
  that takes up to 24 hours to apply via a Splunk-triggered nightly restart,
  a poor fit for this pipeline's synchronous validate → deploy → health-check
  model, and risks breaking every installed app if set incorrectly.

## Coverage

What this app manages, what it deliberately does not, and why — see also the
[Configuration types](#configuration-types) table above for the endpoint each
type calls.

**The ACS-vs-REST-vs-Cloud-restriction boundary.** Splunk Cloud restricts the
classic management REST API (`/services/...`) that Enterprise apps use freely:
it answers only on the stack's management port 8089, which is **closed by
default** and requires a Splunk Support case to open, plus the caller's IP on
the stack's `search-api` ACS-managed allow list. The **Admin Config Service
(ACS)**, reachable over the public internet with just a stack JWT, is Splunk's
supported answer to that restriction — but it is a purpose-built API, not a
REST proxy: it exposes a curated set of Cloud-safe operations, not arbitrary
`.conf` writes. Every type in this app declares which side of that boundary it
uses, and why, in its own manifest description.

### Managed (ACS)

| Group | Types |
|-------|-------|
| Data | `indexes`, `hec-tokens`, `ddss-self-storage` |
| Network & Access | `ip-allowlists`, `ip-allowlists-v6`, `outbound-ports`, `outbound-ports-v6` |
| System Settings | `limits`, `maintenance-windows` |
| Apps | `app-permissions`, `apps` (private, AppInspect-vetted), `splunkbase-apps` (published, pre-vetted) |

All ten cover a genuinely distinct, declarative, round-trippable ACS resource:
a GET to read live state, a POST/PATCH to converge it, captured prior state for
rollback. `ip-allowlists-v6` and `outbound-ports-v6` close this app's own
previously-documented "IPv4/only" limitation, confirmed as real, separate ACS
resources via the ACS API endpoint reference **and** Splunk's official
`terraform-provider-scp` (which models the v6 allow list as its own resource
type, `scp_ip_v6_allowlists`, not a variant of the v4 one — this app follows
that precedent). `splunkbase-apps` closes this app's own former "Future work"
backlog entry.

### Managed (REST by default, ACS opt-in) — `roles`

Splunk's official `terraform-provider-scp`
(`github.com/splunk/terraform-provider-scp`, `docs/resources/roles.md` /
`users.md`) showed this app's original premise — "ACS cannot manage identity,
full stop" — was outdated: ACS has native `/adminconfig/v2/roles`,
`/adminconfig/v2/users` and `/adminconfig/v2/capabilities` endpoints. The
1.11.0 pass corrected the premise but deliberately deferred acting on it (ACS
role writes are not replicated across search-head-cluster members, and
swapping the transport under an already-shipped config type deserved its own
design pass, not a drive-by rewrite). **This pass is that dedicated design +
build effort**: `roles` now supports ACS as an opt-in, per-item transport,
alongside the unchanged REST default — see [Search-head
targeting](#search-head-targeting-for-acs-native-roles) for the full design
and citations, and the [`roles` fields](#roles-fields) table for the two new
canvas fields (`transport`, `searchHeadTargets`). The `capabilities` list
itself (a pure read, no identity write) has used the native ACS lookup since
1.11.0 regardless of which transport the role itself deploys through.

### Managed (Splunk Cloud Platform REST API, port 8089, only)

| Type | Why REST, not ACS |
|------|--------------------|
| `users` | ACS's native `/adminconfig/v2/users` endpoint has **no timezone field** — this type manages `tz`, a genuine schema gap, not a transport nicety. See the "WHY THIS TYPE STAYS REST-ONLY" note in `config-types/users/validate.ts`. Also carries the same search-head-cluster non-replication caveat `roles`' ACS transport does. |
| `authentication-tokens` | ACS exposes only per-token CRUD (secrets), not the stack-wide enablement/expiration setting |
| `sso` | ACS has no SAML endpoint found in the sources reviewed |

These three require Splunk Support to open port 8089 and the caller's IP on the
`search-api` allow list — the two prerequisites named throughout this README.
Revisit `users` if ACS's user schema ever gains a timezone attribute; the other
two have no ACS equivalent found at all regardless of schema evolution (no
per-token bulk setting, no SAML surface).

### Excluded, with reasons

| Surface | ACS endpoint | Why excluded |
|---------|--------------|--------------|
| ACS stack tokens | `GET/POST/DELETE /tokens` | **Secret material**, not declarative config — a token *value* is a credential, not state to diff/redeploy. Same reasoning already applied to HEC token values. Also carries a real self-lockout risk: deleting the token a deployment is currently authenticating with would cut off ACS access mid-pipeline. |
| Enterprise Managed Encryption Keys (EMEK) | `GET /emek/waiver`, `GET/PUT /emek/key-policy`, `PUT /emek/key` | **Gated feature** — requires a Splunk account representative to activate before the endpoints answer at all. Uploading a key is a **one-way bootstrap**: Splunk's own docs say "contact Splunk support to use this EMEK key to re-key your stack" (upload alone does not activate it) and "you cannot use ACS to rotate KMS keys — to change keys, you must contact Splunk Support." Not round-trippable, not safely redeployable/rollback-able, and a misconfigured key is a severe, hard-to-reverse blast radius for a customer-managed-encryption feature. |
| Python runtime version | `GET/POST /python-runtime` | A stack-wide interpreter pin (`force_python3`/`python3`/`python3.7`/`python3.9`) from the Python 2→3 migration era. Applying a change is **asynchronous over up to 24 hours** via a Splunk-triggered nightly restart — a poor fit for this pipeline's synchronous validate → deploy → health-check model — and a wrong value can break every installed app on the stack. Most Cloud stacks already run `python3`/`force_python3` by default; low ongoing utility for the risk. |
| Granular `limits.conf` setting/reset | `GET/PATCH /limits/{stanza}/{setting}`, `DELETE /limits/{stanza}/{reset}` | Not a new surface — the existing `limits` type already achieves the same effect via the bulk `GET /limits` + `POST /limits/{stanza}` shape (idempotent apply, prior value captured for rollback). |
| App export/download | `GET /apps/victoria/export/download/{app_id}` | **One-shot read**, not declarative config — already exposed as the `export-app` **operation** (Operations page), not a config type. |
| Restart / restart status | `POST /restart-now`, `GET /restart/status` | **One-shot action**, already the `restart` **operation**. |
| Retry failed operation / deployment status | `POST /deployment/retry`, `GET /deployment/status` | **One-shot action**, already the `retry-failed` **operation**. |
| Observability Cloud SSO pairing | (referenced in some ACS material reviewed) | Could not be independently corroborated with the same rigor applied to the rest of this pass (unlike roles/users/capabilities, confirmed via Splunk's own `terraform-provider-scp`) — left out rather than shipped on an unverified claim. Worth revisiting if a future pass can confirm it directly against a live stack or a corroborating second source. |

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
- [Access requirements and limitations for the Splunk Cloud Platform REST API](https://help.splunk.com/en/splunk-cloud-platform/leverage-rest-apis/rest-api-tutorials/9.3.2408/rest-api-tutorials/access-requirements-and-limitations-for-the-splunk-cloud-platform-rest-api)
  — the source for the `roles` prerequisites: port 8089 opened by Support, the
  caller's IP on the `search-api` allow list, token auth, no free-trial stacks
- [REST API reference: authorization/roles](https://help.splunk.com/en/splunk-enterprise/rest-api-reference/9.4/access-control-endpoint-descriptions/access-control-endpoint-descriptions#authorization-roles)
- [Define roles on the Splunk platform with capabilities](https://help.splunk.com/en/splunk-cloud-platform/administer/manage-splunk-cloud-platform-users-and-roles/9.3.2408/manage-splunk-cloud-platform-users-and-roles/define-roles-on-the-splunk-platform-with-capabilities)

### Added for the 1.11.0 exhaustion pass

- [Configure outbound ports for Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/configure-outbound-ports-for-splunk-cloud-platform)
  — source for `outbound-ports-v6` (`/access/outbound-ports-v6`)
- [Manage Splunkbase apps in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-splunkbase-apps-in-splunk-cloud-platform)
  — source for `splunkbase-apps`: install/list/describe/upgrade/uninstall paths,
  the `X-Splunkbase-Authorization` / `ACS-Licensing-Ack` headers, and the
  Splunkbase session-login endpoint
- [Manage users, roles, and capabilities in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-users-roles-and-capabilities-in-splunk-cloud-platform)
  — documents ACS's newer native `/adminconfig/v2/roles`, `/adminconfig/v2/users`
  and `/adminconfig/v2/capabilities` endpoints (see [Coverage](#coverage));
  the `capabilities` lookup is the one piece of this surface this app now uses
- [`splunk/terraform-provider-scp`](https://github.com/splunk/terraform-provider-scp)
  ([`docs/resources/roles.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/resources/roles.md),
  [`users.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/resources/users.md),
  [`ipv6_allowlists.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/resources/ipv6_allowlists.md))
  — Splunk's own official Terraform provider; independently corroborates the
  ACS roles/users/IPv6-allowlist endpoints (exact field names, headers, and the
  IPv6 "cannot empty in one call" and search-head-targeting quirks) against a
  second, primary source
- [Provision Enterprise Managed Encryption Keys (EMEK) for Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/provision-enterprise-managed-encryption-keys-emek-for-splunk-cloud-platform)
  — source for the EMEK exclusion reasoning
- [Manage Python versions in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-python-versions-in-splunk-cloud-platform)
  — source for the Python-runtime exclusion reasoning

### Added for the 1.12.0 ACS-native identity + search-head-targeting pass

- [Manage users, roles, and capabilities in Splunk Cloud Platform (ACS)](https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-users-roles-and-capabilities-in-splunk-cloud-platform)
  — re-read in full for this pass: the `/adminconfig/v2/roles` and
  `/adminconfig/v2/users` request/response schemas (including the
  `Federated-Search-Manage-Ack` header, the default-vs-targeted search-head
  URL examples, and the "ACS does not replicate users and roles across the
  search tier" statement this whole design pass is built around)
- [`splunk/terraform-provider-scp`](https://github.com/splunk/terraform-provider-scp)
  — read at the SOURCE level (not just its docs) via `gh api`, since this pass
  needed the exact schema/URL mechanics, not just prose:
  - [`docs/index.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/index.md#targeting-a-search-head)
    — "Targeting A Search Head": the `sh-i-<id>.<stack>` provider-config
    example and "not all features support targeting a specific search head"
  - [`docs/resources/roles.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/resources/roles.md) /
    [`users.md`](https://github.com/splunk/terraform-provider-scp/blob/main/docs/resources/users.md)
    — each resource's own "Search Head Targeting" section
  - [`internal/utils/utils.go`](https://github.com/splunk/terraform-provider-scp/blob/main/internal/utils/utils.go)
    — `TargetStackName()`: `fmt.Sprintf("%s.%s", target, stack)`, confirming the
    targeted-stack string is built exactly as the docs show, in code
  - [`acs/v2/api.gen.go`](https://github.com/splunk/terraform-provider-scp/blob/main/acs/v2/api.gen.go)
    — the generated ACS OpenAPI client (~15,000 lines), searched end to end for
    this pass: confirms `Stack` is a bare string interpolated directly into the
    URL path (`fmt.Sprintf("/%s/adminconfig/v2/roles", pathParam0)`); confirms
    the exact `RolesRequest`/`RolesResponse`/`CreateUserRequest`/`UsersResponse`
    JSON field names (including the response-only nested `imported.roles` vs
    the write-only top-level `importedRoles` — a real, easy-to-miss quirk this
    app's `driftDetect` gets right); confirms **no** endpoint anywhere in the
    client enumerates a stack's search-head-cluster members (searched for
    "member", "instance", "search head", "SHC" — zero matches); confirms
    ACS's user schema (`UsersResponse`/`PatchUserRequest`) has **no timezone
    field**, the reason `users` was not migrated in this pass; confirms the
    `Error{code,message}` body shape already assumed by this app's
    `lib/acs.ts` `acsErrorMessage()`

## License

Apache-2.0
