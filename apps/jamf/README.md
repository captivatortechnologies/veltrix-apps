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
| **Categories** (`categories`) | Categories (Self Service ordering; referenced by name from Scripts and Policies) | Modern (JSON) | `GET/POST/PUT/DELETE /v1/categories/{id}` |
| **Smart Computer Groups** (`smart-computer-groups`) | Smart computer groups (name + criteria) | Classic (XML) | `GET /JSSResource/computergroups`, `GET/POST/PUT/DELETE /computergroups/id/{id}` |
| **Policies** (`policies`) | Policies — name/enabled/triggers/frequency, scope, scripts, packages | Classic (XML) | `GET /JSSResource/policies`, `GET/POST/PUT/DELETE /policies/id/{id}` |

Reconciliation matches by **name** for all four types: `deploy` lists the
existing objects, creates any that are missing, and updates any that already
exist to the declared spec — capturing prior state for rollback.

> **Name uniqueness.** Jamf Pro does **not** enforce unique names for scripts,
> computer groups or policies server-side (categories are effectively unique
> in practice). This app's own canvas rejects duplicate names among the
> objects *you* declare, but if the live tenant already has more than one
> object sharing a name (created outside Veltrix), the first one Jamf Pro
> returns is treated as the match.

### Modern vs. Classic API split

Jamf Pro is migrating its object model from the legacy **Classic API**
(`/JSSResource/…`, XML) to the modern **Jamf Pro API** (`/api/v1/…`, JSON),
but the migration is per-resource and incomplete. As of this release:

- **Scripts and Categories** are fully modern (JSON) — `deploy.ts` uses
  `JamfClient.request` (`lib/jamfApi.ts`).
- **Computer groups and Policies are still Classic-API only for write.** The
  modern API exposes only a **read-only** mirror for computer groups
  (`GET /api/v2/computer-groups/smart-groups`, per the Classic API docs' own
  "Jamf Pro API equivalent" note) and none for policies. `deploy.ts` for
  these two types uses `JamfClient.classicRequest` (`lib/jamfApi.ts`) and the
  hand-rolled XML helpers in `lib/jamfClassicXml.ts` — see
  [Classic API (XML) handling](#classic-api-xml-handling) below.

**Configuration Profiles remain out of scope** for this release — they are a
materially larger Classic-API surface (payload-encoded `.mobileconfig` XML)
planned for a future wave.

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
- **Policies**: a policy document is large (general, scope, scripts,
  packages, self_service, maintenance, disk_encryption, printers, dock_items,
  user_interaction, …) and this config type manages only a subset (see
  `config-types/policies/validate.ts` header). To avoid silently wiping an
  admin's Self Service description, maintenance tasks, etc. configured
  through the Jamf Pro UI, an **update** fetches the policy's current full
  XML first and **merges** only the managed sections into it
  (`mergePolicyXml` in `deploy.ts`) — every other section passes through
  untouched. A **create** builds a fresh minimal document with just the
  managed sections (nothing to preserve yet). Rollback restores the exact
  prior full XML byte-for-byte.
- **Name resolution**: a policy's scope (computer groups), scripts and
  packages are declared **by name** and resolved to live ids at deploy time
  (`loadRefs` in `deploy.ts`) — each referenced object must already exist
  (computer groups via this app's own Smart Computer Groups config type or
  created directly; scripts via this app's Scripts config type; **package
  binaries are not managed by this app** — upload them in Jamf Pro first). A
  name that does not resolve fails that policy's deploy with a clear error;
  it is never silently dropped.

## Authentication

Basic-auth-for-a-bearer-token. Create an **API-only account** in Jamf Pro
(**Settings → System → User Accounts & Groups**) with a **Custom** privilege
set granting Read/Create/Update/Delete under **Jamf Pro Server Objects →
Scripts, Categories, Smart Computer Groups and Policies** (plus **Read** on
**Packages** if any policy deploys one), then store it as a Veltrix
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

**The same Bearer token is reused for the Classic API** (Smart Computer
Groups, Policies). Jamf Pro's own `/v1/auth/token` reference states the token
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
