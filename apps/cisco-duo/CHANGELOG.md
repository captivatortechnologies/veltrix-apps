# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.6.0 — 2026-08-05

### Added
- **Shared Device Authentication** configuration type — manage Duo Desktop
  kiosk/shared-workstation authentication configurations as code via the
  V5(JSON)-signed `/admin/v1/desktop_authenticators/shared_device_auth` API
  (full CRUD: list, get-by-key, create, update, delete — the update call is
  JSON-only per Duo's own docs, so this type reuses the same V5 signer as
  Policies and Passport). Each configuration pairs one or more Duo groups
  (`group_id_list`) with one or more Trusted Endpoints management integrations
  (`trusted_endpoint_integration_id_list`); it is matched by name and its
  `shared_device_key` is stored for rename-safety; reconcile only deletes
  configurations this app created. Management integrations themselves are
  provisioned by enrolling a device-management system in the Duo Admin Panel's
  Trusted Endpoints setup — the Admin API has no endpoint to create or list
  them, only to reference their ids, so operators copy the id from the Admin
  Panel.
- `lib/duo.ts` gained shared `parseList`/`normalizeIdObjects`/`normalizeGroupIds`
  helpers (generalized out of the Passport config type, which now re-exports
  them) for every config type that references Duo objects by a
  newline/comma-separated list of opaque ids.

### Documentation
- Added a README **Coverage** section auditing every config type against the
  current Duo Admin API (`duo.com/docs/adminapi`) and explaining, with
  citations, what is intentionally NOT managed as code: per-user lifecycle
  objects (Users, Phones, Hardware Tokens, WebAuthn Credentials, Desktop
  Authenticators, Bypass Codes — one-shot enrollment/activation actions or
  read-only/delete-only security-key records), Directory Sync (read-only list +
  one-shot per-user sync trigger; the sync profile itself is configured through
  Duo's directory-specific onboarding docs, not the Admin API), Authentication /
  Administrator / Telephony logs and Info/Reports (read-only), "Networks for
  API Access" (an IP allowlist on the Admin API application itself, configured
  only in the Duo Admin Panel — there is no Admin API resource for it), the
  Trusted Endpoints device-trust surface (a separate Device API / product, not
  the Admin API), and Subaccounts/Billing (a different `/accounts/v1` API
  family, MSP-only). Also notes that "Authorized Networks" (network-based 2FA
  bypass/require rules) is already covered generically today, as the
  `authorized_networks` section inside the existing Policies config type's
  round-tripped `sections` blob — not a separate resource.
- Rewrote the rest of the README's "What it manages" and per-type sections,
  which had not been updated since the Groups-only initial release, to
  document all 8 configuration types.

## 0.5.0 — 2026-07-26

### Added
- Cisco Duo Admin API **V5 (sig_version 5) request signer** in `lib/duo.ts`
  alongside the existing v1 HMAC-SHA1 signer: a 7-line canonical string signed
  with HMAC-SHA512, canonical JSON bodies (recursively sorted keys, compact
  separators — the exact bytes hashed equal the bytes sent), the empty-body/
  empty-header SHA-512 constant, and `getV5`/`postV5`/`putV5`/`deleteV5` +
  `getAllV5` (v2 page cap 100) helpers. `PUT` was added to the method union.
- **Policies** configuration type — manage Duo policies (name + a validated JSON
  `sections` settings map) as code via the V5-signed `/admin/v2/policies` API.
  Policies are matched by name and their `policy_key` is stored for rename-safety;
  create is two-step (POST `{name}` then a PUT applies `sections`); custom
  policies are converged to exactly the declared sections (previously-set sections
  no longer declared are cleared); the Global Policy is treated as an update-only
  singleton that is never created, renamed or deleted; reconcile only deletes
  custom policies this app created. `sections` inner settings are round-tripped
  verbatim. The Policies API requires a Duo Access/Essentials (or higher) edition.
- **Passport Configuration** type — manage Duo Passport (desktop SSO) enablement
  as code via the V5-signed `/admin/v2/passport/config` singleton (GET-then-POST
  patch; no create/delete). Covers the enabled status, per-group scoping
  (enabled/disabled group ids) and custom supported browsers per platform;
  rollback re-POSTs the prior configuration captured at deploy.
- **Account Settings** configuration type — manage Duo account-wide (global)
  settings as code via the `/admin/v1/settings` singleton (GET-then-POST patch;
  no create/delete). Covers admin lockout, admin password policy, log retention,
  fraud reporting, timezone and helpdesk bypass. Every field is optional and
  managed only when set (booleans use a tri-state select; unset fields are left
  untouched); rollback restores the prior values of exactly the fields changed.

## 0.4.0 — 2026-07-26

### Added
- **Administrative Units** configuration type — manage Duo administrative units
  (name, description and the `restrict_by_groups` / `restrict_by_integrations`
  flags) as code, with the full pipeline handler set. Units are matched by name
  (Duo requires unique names) and their `admin_unit_id` is stored for
  rename-safety; the scalar fields are reconciled to the declared values;
  reconcile only deletes units this app created. The unit's admin/group/
  integration membership is intentionally not managed here — those are opaque-id
  lists whose modify endpoint only appends, so they are assigned in the Duo Admin
  Panel (turning a restriction flag on warns accordingly).

## 0.3.0 — 2026-07-26

### Added
- **Administrators** configuration type — manage Duo administrators (email, name
  and role) as code, with the full pipeline handler set. Admins are matched by
  email and their `admin_id` is stored for email-change-safety; name/role are
  reconciled to the declared values; reconcile only deletes admins this app
  created. Creating a new administrator sends a Duo activation email; the "Owner"
  role cannot be created/modified via the Admin API (declared Owners warn).

## 0.2.0 — 2026-07-26

### Added
- **Integrations** configuration type — manage Duo integrations (name + type) as
  code, with the full pipeline handler set. Integrations are id-addressed by
  `integration_key` with no lookup-by-name, so the app matches by name and stores
  the key for rename-safety; the type is immutable (a same-name integration of a
  different type is not modified); reconcile only deletes integrations this app
  created. (Duo generates the integration secret; retrieve it from the Admin
  Panel.)

## 0.1.0 — 2026-07-26

### Added
- Initial release. Cisco Duo Admin API client (`lib/duo.ts`) with HMAC-SHA1
  request signing over form-encoded params, the `{stat, response}` envelope,
  `metadata.next_offset` pagination and RFC 2822 date handling.
- **Groups** configuration type — manage Duo groups (name + description) as code,
  with the full pipeline handler set: validate, deploy, rollback, drift detection,
  health check and status. Duo groups are id-addressed with no lookup-by-name, so
  the app matches by name and stores the `group_id` after deploy for
  rename-safety; reconcile only deletes groups this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the integration key + secret key credential and the `cisco-duo`
  deploy target.
- Connection test (`handlers/testConnection.ts`) signing a request to Duo's
  `/admin/v1/check` endpoint.
