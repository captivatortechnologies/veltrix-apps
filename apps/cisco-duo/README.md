# Cisco Duo

Manage **Cisco Duo** configuration as code through the Duo Admin API, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | Duo Admin API surface | Notes |
|---|---|---|
| **Groups** | `/admin/v1/groups` | Name + description. |
| **Integrations** | `/admin/v1/integrations` | Name + type (type immutable). Secret key (`skey`) is write-once by Duo and never round-tripped. |
| **Administrators** | `/admin/v1/admins` | Email + name + role. Creating one sends a Duo activation email; "Owner" is update/read-only via the API. |
| **Administrative Units** | `/admin/v1/administrative_units` | Name + description + `restrict_by_groups`/`restrict_by_integrations` flags. Admin/group/integration membership is assigned in the Duo Admin Panel. |
| **Policies** | `/admin/v2/policies` (V5) | Name + a validated JSON `sections` map, round-tripped verbatim (includes the `authorized_networks` section — see [Coverage](#coverage)). The Global Policy is an update-only singleton. |
| **Passport Configuration** | `/admin/v2/passport/config` (V5) | Tenant singleton — enablement status, optional per-group scoping, custom supported browsers. |
| **Account Settings** | `/admin/v1/settings` | Tenant singleton — admin lockout, admin password policy, log retention, fraud reporting, timezone, helpdesk bypass. |
| **Shared Device Authentication** | `/admin/v1/desktop_authenticators/shared_device_auth` (V5/JSON) | Duo Desktop kiosk/shared-workstation auth — name + active flag + the groups and Trusted Endpoints management integrations it applies to. |

Most Duo objects are addressed by an opaque id with no lookup-by-name, so the
app matches a declared item to a live one by **name** and stores the id from
the deploy for rename-safety on the next deploy. Reconcile only deletes/updates
objects this app created — see each type's section below and `manifest.yaml`
for the exact matching and reconcile rules.

## Authentication

The Duo Admin API supports two request-signing schemes, and this app implements
both (`lib/duo.ts`):

- **v2 signing (legacy, HMAC-SHA1)** — used for the `/admin/v1/...` endpoints
  above except Shared Device Authentication. Parameters are sent as sorted,
  URL-encoded form data; the signature is an HMAC-SHA1 over a
  `date · method · host · path · sorted-params` canonical string.
- **v5 signing (HMAC-SHA512, JSON body)** — required for `/admin/v2/...`
  endpoints (Policies, Passport) and for Shared Device Authentication's update
  call, which Duo's own docs require to be sent as JSON regardless of its
  `/admin/v1/` path. The signature is an HMAC-SHA512 over a 7-line canonical
  string that includes SHA-512 hashes of the body and headers.

Protect an **Admin API** application in the Duo Admin Panel and store the
credential as:

- **Username** → the **Integration key**
- **Password** → the **Secret key** (used as the HMAC key — never sent directly)

Set the **API Host** (`api-XXXXXXXX.duosecurity.com`) in the app's settings,
and grant the integration the "Grant read information" / "Grant read/write
resources" permissions for what this app manages. Lists page via
`metadata.next_offset` for both signing schemes.

## Configuration type: Groups

Each canvas item is one group:

- **Name** — the logical identity (unique in the canvas), ≤ 255 chars.
- **Description** — optional, ≤ 255 chars.

## Configuration type: Integrations

Each canvas item is one integration:

- **Name** — the logical identity (unique in the canvas), ≤ 255 chars.
- **Type** — immutable after creation (e.g. `websdk`, `authapi`, `adminapi`); a
  same-name integration of a different live type is never modified.

Duo generates the integration's secret key (`skey`) at creation time; it is
never returned by a subsequent GET, so this app never reads or writes it —
retrieve it from the Admin Panel when you need to configure the downstream
application.

## Configuration type: Administrators

Each canvas item is one administrator:

- **Email** — the logical identity (unique in the canvas).
- **Name**, **Role** — reconciled to the declared values on every deploy.

Creating a new administrator triggers a Duo activation email. The Admin API
rejects creating or modifying "Owner" administrators — declare an Owner only
if it already exists with that role (a warning flags this).

## Configuration type: Administrative Units

Each canvas item is one administrative unit:

- **Name** — the logical identity (unique in the canvas, required by Duo), ≤ 255 chars.
- **Description** — required by the Duo Admin API.
- **Restrict by Groups** / **Restrict by Integrations** — the unit's restriction flags.

Admin/group/integration **membership** is intentionally not managed here —
Duo's modify endpoint for membership only ever *adds* ids and never removes
them, so it cannot be reconciled idempotently. Assign membership in the Duo
Admin Panel (turning a restriction flag on warns accordingly).

## Configuration type: Policies

Each canvas item is one policy:

- **Name** — the logical identity (unique in the canvas).
- **Is Global** — marks this item as the tenant's Global Policy, an
  update-only singleton that is never created, renamed or deleted via the API.
- **Sections** — a JSON object keyed by policy section name (e.g.
  `2fa_enrollment`, `authentication_policy`, `authorized_networks`,
  `remembered_devices`), each mapping to that section's settings object. The
  inner settings are round-tripped verbatim — their deep schema is not modeled
  by this app, so any section Duo supports can be declared. A custom policy's
  sections are converged to exactly what's declared (a previously-set section
  no longer declared is cleared via `sections_to_delete`).

Requires a Duo Access/Essentials edition or higher.

## Configuration type: Passport Configuration

A tenant **singleton** (exactly one item):

- **Enabled Status** — `disabled` / `enabled` / `enabled-for-groups` / `enabled-with-exceptions`.
- **Enabled Group IDs**, **Disabled Group IDs** — Duo group ids (one per line
  or comma-separated), used when status scopes Passport to specific groups.
- **macOS Browsers**, **Windows Browsers** — additional supported browsers per platform.

Deploy is a GET-then-POST patch; there is no create/delete. Rollback re-POSTs
the exact configuration captured before the deploy.

## Configuration type: Account Settings

A tenant **singleton** covering the account-wide fields listed in the table
above. Every field is optional and only **managed** when the operator sets it
— unset fields are left untouched on both deploy and rollback.

## Configuration type: Shared Device Authentication

Each canvas item is one shared device authentication configuration (Duo
Desktop kiosk / shared-workstation auth):

- **Name** — the logical identity (unique in the canvas), ≤ 255 chars.
- **Active** — whether users can currently authenticate with it (default: on).
- **Group IDs** — Duo group ids (one per line or comma-separated) this
  configuration applies to; required by the Duo Admin API. Use this app's
  Groups config type to create the groups and copy their `group_id`.
- **Trusted Endpoint Management Integration IDs** — Trusted Endpoints
  management integration ids (one per line or comma-separated) this
  configuration authenticates through; required by the Duo Admin API.

Management integrations are provisioned by enrolling a device-management
system (Duo Desktop, an MDM, etc.) in the Duo Admin Panel's Trusted Endpoints
setup — the Admin API has no endpoint to create or list them, so this app only
references their ids; copy them from the Admin Panel.

## Coverage

An audit of the current Duo Admin API (`duo.com/docs/adminapi`, checked
2026-08-05) against what this app manages as code.

### Managed (declarative, round-trippable, full lifecycle)

All 8 configuration types in the table above — Groups, Integrations,
Administrators, Administrative Units, Policies, Passport Configuration,
Account Settings and Shared Device Authentication.

### Intentionally not managed

| Surface | Duo Admin API | Why it's excluded |
|---|---|---|
| **Users** | `/admin/v1/users` (full CRUD), `bulk_create`, `bulk_restore`, `bulk_send_to_trash`, `enroll` | One-shot identity lifecycle (enrollment emails, trash/restore) rather than declarative bulk config; user population is normally sourced from an HR system or IdP via Duo's own Directory Sync, not hand-authored as code. |
| **Phones** | `/admin/v1/phones` (full CRUD), `/admin/v1/users/[id]/phones` | Per-user device lifecycle (activation SMS/link) — a one-shot enrollment action, not persistent declarative state. |
| **Hardware Tokens** | `/admin/v1/tokens` (full CRUD), `/admin/v1/users/[id]/tokens` | Per-user physical-device assignment/resync — one-shot lifecycle, not declarative config. |
| **WebAuthn Credentials** | `/admin/v1/webauthncredentials` — GET (list, by key), DELETE only; no create | Read/delete-only; a credential is only ever created through the end user's own browser WebAuthn registration ceremony, never via API create — this app never manages security-key material. |
| **Desktop Authenticators** | `/admin/v1/users/[id]/desktopauthenticators` — read-only | Per-user Duo Desktop device-trust records; read-only, no config to declare. |
| **U2F Tokens** | `/admin/v1/users/[id]/u2ftokens` — read-only, deprecated | Read-only and deprecated in favor of WebAuthn. |
| **Bypass Codes** | `/admin/v1/users/[id]/bypass_codes` (create/read), `/admin/v1/bypass_codes` (read/delete) | Single-use secret codes for a one-shot helpdesk bypass action — secret material, not persistent config. |
| **Directory Sync** | `/admin/v1/users/directorysync` — read-only list; `.../directorysync/[key]/syncuser` and `/admin/v1/admins/directorysync/[key]/syncadmin` — one-shot sync trigger | The sync *profile* itself (LDAP/AD/Entra ID/Google connection details) is configured through Duo's directory-specific onboarding docs (`duo.com/docs/adsync`, `azuresync`, `ldapsync`, `googlesync`), not the Admin API; the Admin API only lists existing syncs and fires a one-shot per-user/per-admin sync. |
| **Authentication / Administrator / Telephony Logs, Offline Enrollment Log** | `/admin/v1/logs/authentication`, `/admin/v1/logs/administrator`, `/admin/v1/logs/telephony` (V2), `/admin/v1/logs/offline_enrollment` | Read-only audit/event data, not configuration. |
| **Info / Reports** | `/admin/v1/info/summary`, `/authentication_attempts`, `/user_authentication_attempts`, `/telephony_credits_used` | Read-only usage/reporting data. |
| **Endpoints (device inventory)** | `/admin/v1/endpoints`, `/admin/v1/endpoints/[epkey]` — read-only | A read-only inventory of devices Duo has observed; there is no create/update/delete. |
| **Trusted Endpoints device-trust data** | Duo Device API (`duo.com/docs/deviceapi`) | A separate API/product (its own auth scheme) used to seed a device cache for Trusted Endpoints — distinct from the Admin API this app authenticates to. Out of scope for this app; see Shared Device Authentication above for the one Trusted-Endpoints-adjacent surface the *Admin* API does expose. |
| **"Networks for API Access"** | No API resource — Admin Panel only | An IP allowlist restricting *this Admin API application itself*, configured only in the Duo Admin Panel. There is no Admin API endpoint to read or write it, and doing so through the very credential it restricts would risk a self-inflicted lockout. |
| **"Authorized Networks" (network-based 2FA bypass/require rules)** | Not a separate resource — it's Policies' `sections.authorized_networks` | Already covered today: this is a **section inside the existing Policies config type**, whose `sections` JSON is round-tripped verbatim (see the Policies section above). No separate config type is needed. |
| **Subaccounts / Billing** | `/accounts/v1/account/*`, `/admin/v1/billing/edition`, `/admin/v1/billing/telephony_credits` | A different API family (Accounts API) requiring a parent-account (MSP) credential — out of scope for a single-tenant Duo Admin API integration. |

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs cisco-duo

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/cisco-duo
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
