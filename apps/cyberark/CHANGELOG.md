# Changelog

All notable changes to the CyberArk Privileged Access Manager app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.3.0 — 2026-08-04

### Added — exhausting the PVWA config-as-code write surface

Seven new configuration types, researched against the PVWA REST API (Gen2
`/PasswordVault/API` and, for Applications, the classic
`/PasswordVault/WebServices/PIMServices.svc`). See the README **Coverage**
section for the full managed-vs-excluded breakdown and every secret-handling
rule.

- **Applications** (`cyberark-applications`) — AAM/CCP application identities
  and their authentication methods (path / hash / OS user / **machine
  address — the CCP "allowed machines" surface** / certificate serial number /
  certificate attributes), over the classic Web Services. Reconciled by AppID;
  created when missing (⚠ **no verified update endpoint** for an application's
  own fields — see Coverage), authentication methods always fully reconciled
  (add/remove) by their semantic signature.
- **Account Groups** (`cyberark-account-groups`) — `/AccountGroups` for
  group-based credential rotation. Reconciled by (safe, group name); members
  are declared as (account name, safe) pairs and resolved to CyberArk's
  internal AccountID at deploy time. ⚠ **CyberArk exposes no REST
  delete-group endpoint** — rollback of a created group can only clear its
  membership, not remove the group object (documented, reported explicitly).
- **Platform Session Policy** (`cyberark-platform-session-policy`) —
  `/Platforms/Targets/{id}/PrivilegedSessionManagement`, a read/replace
  singleton per platform (PSM server + connector enablement). **This corrects
  the 1.2.0 note below** — the session-management slice of "Master Policy" IS
  writable; the other privileged-access-workflow settings (dual control,
  exclusive access, OTP, reason-for-access) remain unconfirmed writable.
- **Directory Mappings** (`cyberark-directory-mappings`) — LDAP/AD group →
  Vault group + authorization mappings on an **existing** directory.
  Reconciled by (directory name, mapping name); the directory CONNECTION
  itself (which needs a BindPassword) is out of scope by design — see
  Coverage.
- **Vault Users** (`cyberark-vault-users`) — `/Users`, reconciled by username.
  The `initialPassword` is write-only and sent only on create, mirroring the
  Accounts secret rule exactly; password reset is intentionally not exposed
  (this app never manages credential rotation).
- **Vault Groups** (`cyberark-vault-groups`) — `/UserGroups` + membership,
  reconciled by group name. Unlike Account Groups, `UserGroups` exposes a real
  delete endpoint, so this type is fully create/update/delete reversible.
- **Allowed Referrers** (`cyberark-allowed-referrers`) — PVWA's server-wide
  HTTP-referrer allow-list. ⚠ **Create-only over REST** in the sources
  verified for this app (GET + POST only) — an existing entry's
  `regularExpression` flag cannot be changed and is reported as informational
  drift; rollback deletion is attempted best-effort and never fails the whole
  rollback if it can't be confirmed.

### Changed

- `lib/cyberark.ts`: `CyberArkClient` now supports a second, LEGACY request
  base (`requestLegacy()`, `/PasswordVault/WebServices/PIMServices.svc`) for
  the Applications config type, reusing the same session token.
  `parseCollectionArray()` now also accepts a bare top-level JSON array (some
  classic endpoints respond this way). Added a shared `readStringList()`
  helper for the several new free-text list fields (domain groups, vault
  authorizations, authentication methods, …) whose exact CyberArk enum isn't
  independently confirmed — modeled as `tags` rather than a possibly-incomplete
  `select`/`multiselect`.
- Every configuration type (new and existing) now declares a manifest `group`
  for sidebar organization: **Safes**, **Accounts**, **Platforms**,
  **Applications**, **Directory**, **Users & Groups**, **Server**.

### Notes

- **DROPPED, with reasons** (see README "Coverage" for the full list):
  PTA administration/security config (separate PTA authentication/session,
  not the PVWA logon flow this client models; its Global Catalog connectivity
  setup needs an LDAP bind password; its admin/security endpoints are opaque
  property-key PATCH operations, not a stable typed resource); LDAP directory
  CREATE/UPDATE (needs a BindPassword); Vault user password reset; Group /
  Rotational / Dependent / Stored platform variants and Connection Component
  import (narrow, advanced features deferred to a future pass); Mappings
  Reorder (would require the full ordered id list of every mapping in a
  directory, risking mappings outside this app's scope).

## 1.2.0 — 2026-07-26

### Added
- **Platforms configuration type.** Manage CyberArk target platforms as code
  through the PVWA REST API. Each item is reconciled by its **PlatformID**
  (`GET /PasswordVault/API/Platforms/Targets`):
  - A platform that does not yet exist is **imported** from a supplied BASE 64
    platform package (`POST /PasswordVault/API/Platforms/Import`). The package
    field is **write-only** — sent only on import and never read back, diffed, or
    stored in rollback data, artifacts or logs (mirrors the account-secret rule).
  - The platform's **active state** is enforced with
    `POST /PasswordVault/API/Platforms/Targets/{id}/activate` /
    `…/deactivate`.
  - Rollback deletes an imported platform
    (`DELETE /PasswordVault/API/Platforms/Targets/{id}`) and restores a changed
    platform's prior active state. Drift and health checks report a missing
    platform and any active-state mismatch.
- **Automatic onboarding rules configuration type.** Manage CyberArk automatic
  onboarding rules as code (`/PasswordVault/API/AutomaticOnboardingRules`),
  reconciled by the unique **rule name**. Discovered accounts that match a rule
  are onboarded to the rule's target Safe against its target platform.
  - Create (`POST`), full-replace update (`PUT …/{id}`) and rollback delete
    (`DELETE …/{id}`) are all supported; the target platform/safe, system &
    machine type, account category, admin-ID, username and address filters (with
    match methods) and description are managed declaratively. Drift and health
    checks report a missing rule and any changed field.

### Notes
- **Master Policy / per-platform privileged access workflows are read-only over
  REST.** CyberArk exposes each platform's privileged access workflows (dual
  control, exclusive check-in/check-out, one-time password access,
  reason-for-access) on `GET /Platforms/Targets`, but the only writable platform
  endpoints are import, activate/deactivate and rename — there is no REST API to
  set these workflow settings or the Master Policy (they are configured via the
  platform package or the PVWA UI). This app therefore does not offer a
  deployable "privileged access policy" type; the Platforms type manages the
  platforms that carry those settings via import/activate.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed CyberArk object, each reported difference is now annotated with the
  person who made the last change and when. The platform stores the `actor` on
  each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - **Accounts** are attributed from the per-account Activities log
    (`GET /Accounts/{id}/Activities`), which records every action with its
    `User`, `Date` and `Action`. Attribution picks the most recent human,
    non-Veltrix activity, preferring change-type actions (modify / update / add /
    rename / change / enable / disable / …) and excluding the CPM component's
    automated rotations, so it reflects a *manual* change.
  - **Safes** are attributed from the `creator` principal and `creationTime` /
    `lastModificationTime` the PVWA already returns on the safe object, so no
    extra API call is made. CyberArk records only the creator identity on a safe
    (not a distinct last-modifier), so a safe is attributed to its creator — the
    closest attribution the Gen2 API affords — with the timestamp reflecting its
    last modification.
  - **Safe members** carry no creator/modifier metadata in the Gen2 API and have
    no per-member activity endpoint, so member diffs cannot be attributed with
    the app's credentials and are reported without an actor (the drift view shows
    "—").
  - Veltrix's own deploys are recorded under the connection's manager account, so
    a change WE made is excluded via that username — the attribution reflects the
    *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an empty log, a missing source, or no usable human
    event, the diff is reported without an actor. Only objects that actually
    drifted are resolved (one resolution per drifted object).
