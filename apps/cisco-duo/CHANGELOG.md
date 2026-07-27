# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

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
