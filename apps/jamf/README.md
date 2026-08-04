# Jamf (Veltrix app)

Manage [Jamf Pro](https://www.jamf.com/products/jamf-pro/) (Apple MDM /
endpoint management) configuration as code through **both the modern Jamf
Pro API and the legacy Classic (XML) API**, driven by the Veltrix
Security-as-Code pipeline (validate → deploy → health check → drift detect →
rollback).

## What it manages

| Configuration type | Jamf Pro object | API | Operations |
| --- | --- | --- | --- |
| **Scripts** (`scripts`) | Scripts (shell/zsh payloads a policy runs at Before / After / At Reboot priority) | Modern (JSON) | `GET /v1/scripts` (list), `GET/POST/PUT/DELETE /v1/scripts/{id}` |
| **Categories** (`categories`) | Categories (Self Service ordering; referenced by name from Scripts, Packages and Policies) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/categories/{id}` |
| **Departments** (`departments`) | Departments (name only) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/departments/{id}` |
| **Buildings** (`buildings`) | Buildings (name + postal address) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/buildings/{id}` |
| **Computer Extension Attributes** (`computer-extension-attributes`) | Computer inventory attributes (Script/Text/Pop-up/Directory-backed) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/computer-extension-attributes/{id}` |
| **Packages** (`packages`) | Package metadata records (not the binary) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/packages/{id}` |
| **Smart Computer Groups** (`smart-computer-groups`) | Smart computer groups (name + criteria) | Classic (XML) | `GET /JSSResource/computergroups`, `GET/POST/PUT/DELETE /computergroups/id/{id}` |
| **Static Computer Groups** (`static-computer-groups`) | Static computer groups (name + members by serial number) | Classic (XML) | `GET /JSSResource/computergroups`, `GET/POST/PUT/DELETE /computergroups/id/{id}` |
| **Policies** (`policies`) | Policies — name/enabled/triggers/frequency, scope, scripts, packages | Classic (XML) | `GET /JSSResource/policies`, `GET/POST/PUT/DELETE /policies/id/{id}` |
| **Restricted Software** (`restricted-software`) | Restricted software — process detection + notify/kill/delete response + scope | Classic (XML) | `GET /JSSResource/restrictedsoftware`, `GET/POST/PUT/DELETE /restrictedsoftware/id/{id}` |
| **macOS Configuration Profiles** (`macos-configuration-profiles`) | Configuration profiles — wrapper + scope; plist payload is opaque | Classic (XML) | `GET /JSSResource/osxconfigurationprofiles`, `GET/POST/PUT/DELETE /osxconfigurationprofiles/id/{id}` |

Reconciliation matches by **name** for every type: `deploy` lists the
existing objects, creates any that are missing, and updates any that already
exist to the declared spec — capturing prior state for rollback.

See [**Coverage**](#coverage) below for the full picture: everything this app
manages, and everything intentionally excluded and why.

> **Name uniqueness.** Jamf Pro does **not** enforce unique names for
> scripts, computer groups, policies or restricted software server-side
> (categories, departments, buildings, extension attributes and packages are
> effectively unique in practice). This app's own canvas rejects duplicate
> names among the objects *you* declare, but if the live tenant already has
> more than one object sharing a name (created outside Veltrix), the first
> one Jamf Pro returns is treated as the match.

### Modern vs. Classic API split

Jamf Pro is migrating its object model from the legacy **Classic API**
(`/JSSResource/…`, XML) to the modern **Jamf Pro API** (`/api/v1/…`, JSON),
but the migration is per-resource and incomplete. As of this release:

- **Fully modern (JSON)** — `deploy.ts` uses `JamfClient.request`
  (`lib/jamfApi.ts`): Scripts, Categories, Departments, Buildings, Packages
  (metadata), and Computer Extension Attributes.
  - Computer Extension Attributes is a **deliberate deviation** from a
    Classic-first default: its own Classic API docs state "The Jamf Pro API
    offers full parity for this resource. We recommend using the Jamf Pro
    API for new integrations" — verified before building, so this config
    type uses `/v1/computer-extension-attributes` instead of the Classic
    `/JSSResource/computerextensionattributes`.
- **Classic-API only for write** — `deploy.ts` uses
  `JamfClient.classicRequest` (`lib/jamfApi.ts`) and the hand-rolled XML
  helpers in `lib/jamfClassicXml.ts`: Smart/Static Computer Groups, Policies,
  Restricted Software, and macOS Configuration Profiles. For computer
  groups, the modern API exposes only **read-only** mirrors
  (`GET /api/v2/computer-groups/smart-groups` and `.../static-groups`, both
  per the Classic API docs' own "Jamf Pro API equivalent" notes); Policies,
  Restricted Software and Configuration Profiles have no modern API
  equivalent at all. See [Classic API (XML) handling](#classic-api-xml-handling)
  below.

### Classic API (XML) handling

Apps may not add npm dependencies, so there is no XML library available.
`lib/jamfClassicXml.ts` hand-rolls just enough of an XML parser/serializer for
the fixed, well-known Classic schemas this app reads and writes — it is
**not** a general-purpose XML engine (see the file's header comment for the
"no same-name nesting" assumption it relies on, which holds for every element
this app touches).

- **Smart Computer Groups**: a plain create (`buildComputerGroupXml`) or
  update sends a fresh `<computer_group>` document (name, `is_smart=true`,
  criteria). It intentionally omits `<site>` (multi-site scoping) — not a
  managed field — so a plain update may reset a group's Jamf Pro **Site**
  assignment on multi-site tenants. A **rollback** restores the exact prior
  XML byte-for-byte (captured before the update), so Site is only at risk
  between a deploy and its own rollback, not after one.
- **Static Computer Groups** share the same Classic resource and the same
  `<site>` caveat as Smart Computer Groups, but declare an explicit
  `<computers>` membership list (`is_smart=false`) instead of criteria.
  Membership is declared by **serial number** — stable and human-readable
  off the physical device, unlike the Jamf-internal numeric computer id or
  the more easily renamed/duplicated inventory "Computer Name" — and
  resolved to a live computer id via the Classic
  `GET /computers/serialnumber/{sn}` lookup. That specific endpoint is
  **deprecated as of 2025-02-11** (Jamf recommends
  `GET /api/v3/computers-inventory` instead) but still functional; flagged
  here rather than silently relied upon. Reconciliation matches only
  existing **static** groups, so a same-named smart group is never mistaken
  for a match.
- **Policies, Restricted Software and macOS Configuration Profiles** are all
  large documents (Policies/Restricted Software: general + scope +
  self_service + maintenance + …; Profiles: general + scope + self_service)
  and each config type manages only a documented subset of fields (see each
  type's `validate.ts` header). To avoid silently wiping an admin's Self
  Service description, maintenance tasks, plist category, etc. configured
  through the Jamf Pro UI, an **update** fetches the record's current full
  XML first and **merges** only the managed sections into it
  (`mergePolicyXml` / `mergeRestrictedSoftwareXml` / `mergeProfileXml` in
  each type's `deploy.ts`) — every other section passes through untouched. A
  **create** builds a fresh minimal document with just the managed sections
  (nothing to preserve yet). Rollback restores the exact prior full XML
  byte-for-byte for all three.
- **macOS Configuration Profiles' plist payload is OPAQUE.** `general.payloads`
  holds the entire embedded Apple `.mobileconfig` plist (itself XML) as a
  single string — this app never parses, generates or validates plist
  content; the operator pastes the complete plist XML and it passes through
  verbatim, escaped/unescaped as ordinary XML text content of `<payloads>`
  exactly like every other leaf. A dedicated test
  (`__tests__/deploy.test.ts`) verifies the plist's own `<`/`>` characters
  survive escaping without corrupting the surrounding document.
- **Name resolution**: a Policy's/Restricted Software's/Profile's
  computer-group scope (and a Policy's scripts and packages) are declared
  **by name** and resolved to live ids at deploy time — each referenced
  object must already exist (computer groups via this app's own Smart/Static
  Computer Groups config types or created directly; scripts via this app's
  Scripts config type; **package binaries are not managed by this app** —
  upload them in Jamf Pro first). A name that does not resolve fails that
  record's deploy with a clear error; it is never silently dropped.

## Authentication

Basic-auth-for-a-bearer-token. Create an **API-only account** in Jamf Pro
(**Settings → System → User Accounts & Groups**) with a **Custom** privilege
set granting Read/Create/Update/Delete under **Jamf Pro Server Objects →
Scripts, Categories, Departments, Buildings, Computer Extension Attributes,
Packages, Smart Computer Groups, Static Computer Groups, Policies,
Restricted Software and Configuration Profiles** (Read on Packages is
sufficient if you never deploy one; Computers/Read is needed for Static
Computer Groups' serial-number lookups), then store it as a Veltrix
credential:

- **Username** → the API-only account's username
- **Password** → the API-only account's password

The app exchanges these for a short-lived Bearer token:

```
POST https://<host>/api/v1/auth/token       Authorization: Basic base64(user:pass)
  -> 200 { "token": "<JWT>", "expires": "<ISO-8601 timestamp>" }
```

([Jamf Pro API reference](https://developer.jamf.com/jamf-pro/reference/post_v1-auth-token))
The token is cached and re-acquired shortly before `expires`; a `401` on any
subsequent call also forces one re-acquisition + retry (the token may have
been invalidated server-side, e.g. by a password change).

**The same Bearer token is reused for the Classic API** (Smart/Static
Computer Groups, Policies, Restricted Software, macOS Configuration
Profiles). Jamf Pro's own `/v1/auth/token` reference states the token
"functions as a Bearer token for all other Jamf Pro API endpoints", and
Jamf Pro 10.35+ is documented (Bearer Token Authentication for Classic API)
to accept it on Classic endpoints too — though a handful of individual
Classic reference pages in the current developer portal still list only
"Basic Authentication" per operation (most likely stale/incomplete OpenAPI
metadata). `JamfClient.classicRequest` (`lib/jamfApi.ts`) tries the cached
Bearer token first and falls back to plain HTTP Basic auth on a `401`, so it
is correct regardless of which claim holds for a given tenant.

### OAuth2 client credentials (not used by this app — documented for completeness)

Jamf Pro 10.49+ also supports **API Roles and Clients** — an OAuth2
client-credentials flow:

```
POST https://<host>/api/v1/oauth/token       (form-encoded)
  grant_type=client_credentials&client_id=<id>&client_secret=<secret>
  -> 200 { "access_token": "<JWT>", "token_type": "Bearer", "expires_in": <seconds>, "scope": "api-role:<id> …" }
```

([Jamf Pro API reference](https://developer.jamf.com/jamf-pro/reference/postoauthtoken),
[Client Credentials guide](https://developer.jamf.com/jamf-pro/docs/client-credentials))
This app deliberately uses the username/password flow instead, because it
works against **every** Jamf Pro version this app supports (not just 10.49+)
and needs no additional Jamf Pro-side API Role/Client setup. Supporting API
Roles and Clients as an alternate credential shape is a natural follow-up.

## Component

Register a `jamf-pro-server` component whose **hostname** is your Jamf Pro
server, e.g. `yourcompany.jamfcloud.com` (Jamf Cloud) or an on-prem FQDN. The
same component serves both APIs: modern requests go to `https://<host>/api`,
Classic requests to `https://<host>/JSSResource` — for an on-prem install on a
non-default HTTPS port (e.g. Tomcat on `:8443`), set the component's port and
it is included in both URLs.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for token + modern/Classic API calls. |
| `page_size` | `100` | Page size used when listing scripts/categories (modern API `page-size` query parameter). Classic API list endpoints (computer groups, policies) return everything in one call — no pagination. |

## Development

```
cd apps/jamf
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs jamf           # run handler tests
node ../../scripts/validate-app.mjs apps/jamf   # validate against the app contract
```

## Coverage

An explicit inventory of the Jamf Pro config-as-code surface: what this app
manages, and what it deliberately excludes and why. Built by enumerating both
the modern Jamf Pro API and the legacy Classic API against
developer.jamf.com, not by assumption — see the CHANGELOG for the
per-release research notes and citations.

### Managed (v0.3.0)

| Config type | API | Notes |
| --- | --- | --- |
| Scripts | Modern | Full CRUD |
| Categories | Modern | Full CRUD |
| Departments | Modern | Full CRUD |
| Buildings | Modern | Full CRUD |
| Computer Extension Attributes | Modern | Full CRUD (deliberately modern, not Classic — see above) |
| Packages | Modern | Metadata only — see "Excluded" below for the binary |
| Smart Computer Groups | Classic | Full CRUD; modern API is read-only for this resource |
| Static Computer Groups | Classic | Full CRUD; modern API is read-only for this resource |
| Policies | Classic | Partial fields (general/scope/scripts/packages), merge-not-replace |
| Restricted Software | Classic | Partial fields (general/scope), merge-not-replace; no modern equivalent |
| macOS Configuration Profiles | Classic | Wrapper + scope managed; plist payload is an opaque passthrough |

### Intentionally excluded — and why

- **Package binaries.** Packages manages the metadata *record* (name, file
  reference, category, install-behavior flags) but never uploads or stores
  the `.pkg`/`.dmg` binary itself — that's a separate, unlisted multipart
  upload endpoint, out of scope for a config-as-code text pipeline. Upload
  the binary in Jamf Pro first; this app's `file_name` field must match it.
- **Configuration profile / plist internals.** A profile's `payloads` field
  is the entire embedded Apple `.mobileconfig` plist. This app treats it as
  an **opaque string** — passed through verbatim, never parsed, generated,
  or semantically validated. Building a real plist editor (per-payload-type
  typed fields, UUID management, MDM payload catalog) is a substantially
  larger, dedicated project; faking structured support on top of a
  passthrough string would be worse than being explicit about the boundary.
- **PKI / certificates.** Jamf Pro's certificate and CA management
  (`/JSSResource/…certificates…`) issues and stores cryptographic material.
  Managing certificates as text-based config-as-code means either
  round-tripping private key material through the pipeline (a serious
  secret-handling liability) or only ever managing half the object — both
  worse than not touching it. Not managed, on security grounds.
- **LDAP / directory-bind credentials.** Jamf Pro's LDAP server
  configuration embeds bind account credentials. Like PKI material, this is
  credential administration, not declarative config — excluded from a
  text/YAML pipeline for the same reason Veltrix never stores raw secrets in
  a canvas.
- **API Roles/Clients and API-only account credentials.** These ARE the
  authentication mechanism this app itself uses (or its OAuth2 sibling —
  see § Authentication) — an app should not be able to provision or rotate
  its own (or another integration's) credentials as "configuration". Managed
  through Jamf Pro's own admin UI.
- **Managed devices / inventory data** (computers, mobile devices, users).
  These are **enrollment- and agent-owned** — populated by MDM check-in and
  osquery-style inventory collection, not admin-declared config. This app
  only *references* computers (by serial number for Static Computer Groups,
  by name for scope) — it never creates, edits, or deletes a device record.
- **Runtime actions, not state**: MDM commands (lock/wipe/restart), policy
  "Flush Logs", computer/mobile-device "Redeploy MDM", inventory
  recalculation, and update-management "plans" are one-shot operations with
  no steady declared state to reconcile against — fundamentally incompatible
  with a validate → deploy → drift-detect → rollback pipeline built around
  *state*, not *actions*. (Same reasoning `crowdstrike-edr`, `defender-endpoint`
  and other Veltrix apps use to exclude RTR/live-response commands.)
- **Sites** (`/v1/sites`) and **Network Segments**
  (`/JSSResource/networksegments`) are confirmed **read-only** on every API
  surface checked (no POST/PUT/DELETE documented for either) — nothing to
  manage.
- **PreStage Enrollments** (`/v1/computer-prestages`) are a real,
  full-CRUD, config-as-code-shaped surface this app does NOT yet cover —
  correctly identified as out of scope for THIS wave rather than rushed:
  the object is unusually large (Setup Assistant panes, MDM profile
  assignment, account settings, ~40+ fields) and deserves the same
  research-and-build rigor as Policies got, not a shortcut. Sized for a
  dedicated future release.
- **Mobile device profiles / restrictions** (the iOS/iPadOS counterparts to
  macOS Configuration Profiles and Restricted Software) are out of scope for
  this release, which is scoped to macOS. The same merge-not-replace /
  opaque-payload approach would extend to them in a future wave.
- **Self Service branding** (icon, description, category placement) on
  Policies and macOS Configuration Profiles is cosmetic UI metadata, not
  security/compliance-relevant config — not managed; set it in the Jamf Pro
  console after deploy if using Self Service distribution.

These are deliberate **drop-don't-fake** boundaries, not gaps discovered
later — each one was evaluated against the actual Jamf Pro API surface
before being excluded.
