# Sophos Central (Veltrix app)

Manage [Sophos Central](https://www.sophos.com/en-us/products/managed-outcomes/central)
endpoint configuration as code through the **Sophos Central public APIs**
(developer.sophos.com), driven by the Veltrix Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | Sophos object | Identity | API operations |
| --- | --- | --- | --- |
| **Endpoint Policies** (`endpoint-policies`) | Named policy (19 documented types) | `(name, type)` | `GET/POST /endpoint/v1/policies`, `PATCH/DELETE .../policies/{policyId}` |
| **Endpoint Groups** (`endpoint-groups`) | Static endpoint group | `name` | `GET/POST /endpoint/v1/endpoint-groups`, `PATCH/DELETE .../endpoint-groups/{groupId}`, plus `.../endpoints` membership |
| **Scanning Exclusions** (`scanning-exclusions`) | Tenant-wide scanning exclusion | `(type, value)` | `GET/POST /endpoint/v1/settings/exclusions/scanning`, `PATCH/DELETE .../{exclusionId}` |
| **Allowed Items** (`allowed-items`) | Tenant-wide allow-list item | `(type, value)` | `GET/POST /endpoint/v1/settings/allowed-items`, `PATCH/DELETE .../{allowedItemId}` |
| **Blocked Items** (`blocked-items`) | Tenant-wide SHA256 block-list item | SHA256 | `GET/POST /endpoint/v1/settings/blocked-items`, `DELETE .../{blockedItemId}` (no PATCH) |
| **Web Control Local Sites** (`web-control-local-sites`) | Custom URL classification | `url` | `GET/POST /endpoint/v1/settings/web-control/local-sites`, `PATCH/DELETE .../{localSiteId}` |
| **Exploit Mitigation Exclusions** (`exploit-mitigation-applications`) | Custom protected-application exclusion | `path` | `GET/POST /endpoint/v1/settings/exploit-mitigation/applications`, `PATCH/DELETE .../{id}` |
| **Custom Roles** (`custom-roles`) | Tenant RBAC role | `name` | `GET/POST /common/v1/roles`, `PATCH/DELETE .../roles/{roleId}` |

### Endpoint Policies — one generic resource, 19 documented types

Sophos's public Endpoint Policy API is **one resource collection**
(`/endpoint/v1/policies`) with a `type` discriminator, not a separate REST
endpoint per policy family. This app mirrors that shape exactly rather than
inventing separate config types per family: one canvas item = one policy,
`type` selects which of the 19 documented policy types it is (immutable
after creation — delete and recreate to change it), and `appliesTo` /
`settings` are authored as JSON, following the same precedent as Cisco
Meraki's Group Policies config type (`config-types/group-policies` in the
sibling app) — Sophos's own docs describe the settings schema as "keys have
specific names documented here" rather than a fixed shape, so flattening it
into dozens of type-specific canvas fields would either be incomplete or
immediately stale. `validate` only checks the well-known scalar fields
(`name`, `type`, `disableAt`) and the documented `appliesTo` keys
(`endpoints`, `users`, `userGroups`) — everything inside `settings` passes
through as declared and is validated by Sophos itself at deploy time.

**No `data-loss-prevention` policy type.** The task brief for this app
anticipated a DLP policy family, but the live `POST /policies` and
`GET /policies/{policyType}/base` schemas (verified 2026-08) only document
19 types — `threat-protection`, `peripheral-control`, `application-control`,
`web-control`, `agent-updating`, `windows-firewall`, `device-encryption`,
`data-collection-and-investigation`, `endpoint-dns-protection`, and their
nine `server-*` equivalents. Sophos Central's product does have DLP rules,
but they are not exposed through this public API version — dropped honestly
rather than fabricated.

### Endpoint Groups — static membership, no dynamic/query-based groups

Unlike some EDR host-group APIs (e.g. CrowdStrike Falcon's FQL-based dynamic
host groups), Sophos Central endpoint groups have **only** a static
`endpointIds` list. `deploy` fully reconciles a group's membership on every
run — it reads the group's current members, computes the add/remove diff
against the declared list, and applies it via the group's
`.../endpoints` sub-resource (`POST` to add, up to 1000 ids per call;
`DELETE` with an `ids` query parameter to remove, up to 50 ids per call —
these limits differ, and the client chunks accordingly). `type` (computer
vs. server) is immutable after creation.

### Blocked Items — no PATCH; a changed item is deleted and recreated

`POST/GET/DELETE /settings/blocked-items` is the full documented surface —
there is no `PATCH`. `deploy` therefore treats any change to an existing
item's `fileName`/`path`/`comment` as delete-then-recreate rather than
silently dropping the change. Allowed Items, by contrast, do have a `PATCH`,
but it **only** accepts `comment` — `type`/`properties` are immutable there
too, so the same delete-then-recreate path applies to any change beyond the
comment.

## Authentication

An OAuth2 **client-credentials service principal**, created as a **tenant**
admin in Sophos Central Admin (**Global Settings > API Credentials** — see
Sophos's own
[Getting Started as a Tenant](https://developer.sophos.com/getting-started-tenant)
guide). Store it as a Veltrix credential:

- **username** → the service principal's Client ID
- **API token** → the service principal's Client Secret

The app exchanges these for a bearer token via a single global endpoint:

```
POST https://id.sophos.com/api/v2/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=token
```

It then calls the global Who-Am-I API with that token to resolve the
tenant's UUID and its **data-region API host** — there is no data-region
setting to configure by hand:

```
GET https://api.central.sophos.com/whoami/v1
Authorization: Bearer <jwt>

-> { "id": "<tenant-uuid>", "idType": "tenant",
     "apiHosts": { "global": "https://api.central.sophos.com",
                    "dataRegion": "https://api-us02.central.sophos.com" } }
```

Every subsequent request goes to `apiHosts.dataRegion` with both
`Authorization: Bearer <jwt>` and `X-Tenant-ID: <tenant-uuid>` headers. If
Who-Am-I reports `idType` other than `"tenant"` (i.e. the credential is a
partner or organization/Enterprise principal), the client fails fast with a
clear error — this app manages one tenant's endpoint configuration and is
not built for partner/organization-level fan-out.

Tokens are cached (~1 hour TTL per the documented `expires_in`, refreshed
with a 60-second margin) alongside the resolved tenant id and data-region
host, keyed by the client id/secret pair, so consecutive pipeline handlers
(validate → deploy → healthCheck) reuse one token/Who-Am-I round trip.

## Component

Register a `sophos-tenant` component and attach the credential. Because the
data-region API host is discovered automatically via Who-Am-I, the
component's hostname is only a human label (e.g. your tenant's name) and is
never used as an address.

## Rate limiting and retries

Per Sophos's own [background docs](https://developer.sophos.com/intro):
10 requests/second, 100/minute (bursts to 300/minute), 1,000/hour and
200,000/day, all enforced per credential set. A `429` or `5xx` response is
retried up to twice with full-jitter exponential backoff (base 1s, cap 30s —
the exact formula Sophos's own docs recommend), rather than a fixed
Retry-After header (Sophos's error responses don't document one, unlike some
other vendors in this repo).

## Pagination

List endpoints are fetched to completion rather than truncated at one page.
Most Sophos Central list endpoints page by offset (`page`/`pageSize`/
`pageTotal`); a group's endpoint membership list pages by key
(`pageFromKey`/`pageSize`/`pageTotal`) instead — both are handled
transparently by `lib/sophosCentral.ts`'s `listAllPages` /
`listAllPagesByKey` helpers, capped at 50 pages as a runaway-loop safety net.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Sophos Central API calls. |

## Development

```
cd apps/sophos-central
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs sophos-central         # run handler tests
node ../../scripts/validate-app.mjs apps/sophos-central # validate against the app contract
```

## Coverage (v0.1.0)

Coverage was audited against the Sophos Central API reference
(developer.sophos.com — Endpoint API v1 and Common API v1 OAS 3.0
specifications, and the "How Our APIs Work" background docs, verified
2026-08-05).

### Managed declarative endpoint configuration

| Configuration type | Endpoint API operations |
| --- | --- |
| Endpoint policies | list/create/get/update/delete `/endpoint/v1/policies[/{policyId}]` (19 documented `type` values) |
| Endpoint groups | list/create/get/update/delete `/endpoint/v1/endpoint-groups[/{groupId}]` plus membership add/remove via `.../endpoints` |
| Scanning exclusions | list/create/get/update/delete `/endpoint/v1/settings/exclusions/scanning[/{exclusionId}]` |
| Allowed items | list/create/get/update/delete `/endpoint/v1/settings/allowed-items[/{allowedItemId}]` |
| Blocked items | list/create/get/delete `/endpoint/v1/settings/blocked-items[/{blockedItemId}]` (no update) |
| Web Control local sites | list/create/get/update/delete `/endpoint/v1/settings/web-control/local-sites[/{localSiteId}]` |
| Exploit Mitigation exclusions | list/create/get/update/delete `/endpoint/v1/settings/exploit-mitigation/applications[/{id}]` (custom applications only — `modifications` is documented for Sophos's own DETECTED applications, which this app does not create) |
| Custom roles | list/create/get/update/delete `/common/v1/roles[/{roleId}]` |

### Assessed and intentionally excluded

- **Firewall Management API** (`firewall-v1`) — assessed per this task's
  brief. It is **not** a granular, field-level declarative surface: its
  write operations are a whole-config **export/import** (opaque blob via
  `POST .../firewalls/{firewallId}/export` and
  `POST .../firewalls/import`, tracked by an async transaction id), device
  fleet actions (`POST .../firewalls/{firewallId}/action`,
  firmware-upgrade — one-shot, not durable state), `firewall-groups`
  CRUD (device grouping only, no rule content), and an MDR threat-feed
  (IOC/indicator management — threat intel, not policy). None of this is a
  round-trippable, field-diffable resource this pipeline can safely manage;
  a future release could model `firewall-groups` the way this app models
  endpoint groups, but the actual firewall rule content is never exposed as
  structured JSON by this API.
- **Data Loss Prevention** — anticipated in this task's brief, but not
  exposed as a `policies` `type` value (or anywhere else in the Endpoint or
  Common API) as of this research pass. See "Endpoint Policies" above.
- **One-shot endpoint actions** — scans, isolation, tamper-protection
  enable/disable per endpoint, update-now, memory dumps, forensic logs,
  migrations, firmware/firmware-upgrade-check, and any other
  `POST .../action`-shaped endpoint are imperative operations, not durable
  desired state, and are excluded per this repo's standing convention.
- **Global Tamper Protection status** (`GET /settings/tamper-protection`) is
  **read-only** (no PATCH) — the actual tamper-protection toggle/password
  lives inside a Threat Protection policy's `settings` JSON blob, which this
  app already manages generically through `endpoint-policies`.
- **Read-only telemetry** — `alerts`, `alerts/search`, `endpoints` (device
  inventory/health), `exploit-mitigation/detected-exploits`,
  `exploit-mitigation/categories`, `web-control/categories` (a reference
  list, not a managed resource), `peripheral-control/peripherals`
  (reference list of peripheral types), and the Detections/Live Discover/
  XDR Query/SIEM Integration/Audit Events APIs are query surfaces, not
  configuration.
- **Agent installers, licensing, mailboxes, mobile devices, DNS/Web
  Filtering products, Wi-Fi/Switch management, Cloud Security** — separate
  product APIs outside this app's endpoint/RBAC scope; candidates for
  future sibling apps rather than scope creep here.
- **Partner API / Organization API** — enumerate and manage tenants across a
  partner or Enterprise organization; this app is built for a single
  tenant's own service principal (see "Authentication" above) and does not
  manage the partner/organization layer, matching this repo's convention for
  other multi-tenant-capable vendors (e.g. CrowdStrike Falcon's Flight
  Control CID groups are a distinct, explicitly-opted-into scope).
- **Directory users/user-groups** (`Common API` `directory/users`,
  `directory/user-groups`) — Sophos Central's end-user directory (as
  distinct from `admins`, who hold RBAC roles). Genuinely declarative and a
  reasonable future addition, but out of scope for this release's endpoint/
  RBAC focus.
- **Admins** (`Common API` `admins` + `role-assignments`) — admin accounts
  have no `PATCH` (create/delete only) and role-assignment management
  overlaps significantly with `custom-roles`; deferred to keep this
  release's RBAC surface to the cleanest, most complete piece
  (role *definitions*) rather than a partial admin-management story.

Primary references: the [Sophos Central APIs](https://developer.sophos.com/)
portal's Endpoint API v1 and Common API v1 references, the
[Who-Am-I API](https://developer.sophos.com/docs/whoami-v1/1/overview), and
the ["How Our APIs Work"](https://developer.sophos.com/intro) background
docs (authentication, multi-tenancy header, pagination, rate limits, and
error-handling conventions all cited above are drawn directly from this
document, verified 2026-08-05).
