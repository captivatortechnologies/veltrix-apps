# Changelog

All notable changes to the BeyondTrust app are documented here.

## 0.3.0 — 2026-08-04

Config-as-code write-surface exhaustion pass against the full BeyondInsight /
Password Safe public v3 API. Five new config types, all driven through the
same PS-Auth session client and pipeline (validate / deploy / rollback /
health-check / drift-detect / status).

- **Managed Systems** config type — create Password Safe **managed systems**
  scoped to an EXISTING workgroup (`POST /Workgroups/{workgroupId}/ManagedSystems`),
  referenced by name and resolved to its id at deploy time. **Re-evaluated from
  the v0.2.0 "considered and dropped" note**: Managed Systems creation under an
  Asset or Database still needs an un-authorable, discovered parent, but the
  Workgroup-scoped creation path does not — and this app already owns
  Workgroup creation (see 0.1.0), so that parent is no longer un-authorable.
  Declares platform id, timeout/port, password/DSS key rule references and
  release-duration policy; some platforms require additional conditional
  fields this app does not model — verify against your target platform.
  Create-if-absent upsert matched by (workgroup, system name); no confirmed
  update or delete endpoint for a system created this way, so rollback reports
  created systems for manual removal rather than guess at an unverified delete
  against live secrets.
- **Managed Accounts** config type — create/update **auto-managed accounts**
  on an existing managed system (`POST`/`PUT` `.../ManagedAccounts`), matched
  by (account name, domain). Unlike every other config type in this app,
  Password Safe DOES expose `PUT /ManagedAccounts/{id}` and
  `DELETE /ManagedAccounts/{id}` — this is a REAL upsert, and rollback restores
  the prior field values for an account it updated (not just deletes one it
  created). **Always `AutoManagementFlag: true`** — this config type never
  authors a `Password`, `PrivateKey` or `Passphrase`; Password Safe generates
  and rotates the secret itself. Manual/static-password accounts are out of
  scope (see "PAM app posture" below).
- **Directories** config type — create/update BeyondInsight **directory
  bindings** (Active Directory / LDAP domain, forest, NetBIOS name, port/SSL/
  timeout) scoped to an existing workgroup (`POST /Workgroups/{id}/Directories`,
  `PUT /Directories/{id}`), matched by (workgroup, domain). A real upsert with
  restore-on-rollback, same shape as Managed Accounts. **Never authors a bind
  credential** — BeyondInsight models the AD/LDAP query credential as a
  separate "Directory Credential" resource; provision it out of band in
  BeyondInsight (Configuration → Role Based Access → Directory Credentials).
- **Address Groups** config type — create BeyondInsight **address groups**
  (`POST /AddressGroups`) and reconcile their member IP addresses
  (`POST`/`DELETE .../Addresses`) against a declared, AUTHORITATIVE list —
  an address removed from the canvas is removed from the live group on the
  next deploy. Full CRUD and no secret material, so this is the one config
  type in this app whose deploy actively reconciles membership rather than
  only creating what's absent. Rollback deletes a group this deploy created,
  or restores/removes exactly the addresses it changed on a pre-existing one.
- **Attributes** config type — create BeyondInsight **attribute types**
  (categories, e.g. "Environment") and **attribute values** (e.g. "Production")
  in one item (`POST /AttributeTypes`, `POST /AttributeTypes/{id}/Attributes`).
  Both tiers are create-if-absent; an attribute type is shared across every
  item that names it and is **never deleted by rollback** — `DELETE
  /AttributeTypes/{id}` cascades to every value under it, which this app
  deliberately never calls. Only the attribute VALUE a deploy created is
  rolled back.

> **PAM app posture — secret material dropped, with reasons:** this release
> re-verified the full Password Safe public API surface and confirmed which
> resources are genuinely read-only (never modeled) versus writable:
> - **Access Policies** — `GET /AccessPolicies` (list) and
>   `POST /AccessPolicies/Test` (evaluate access to an account) are the only
>   documented operations; there is no create/update endpoint. A policy is
>   authored through a full schedule/rule editor in the BeyondInsight console
>   that the public API does not expose for writes. Stays dropped.
> - **Applications** — `GET /Applications` / `GET /Applications/{id}` only; the
>   catalog of registered applications is fixed. (Linking an existing
>   application to a managed account, `POST`/`DELETE
>   /ManagedAccounts/{id}/Applications`, is a sub-resource operation on an
>   already-declarative parent, not a standalone authorable entity.) Stays
>   dropped.
> - **DSS Key Rules** and **Password Rules** — `GET` only across every
>   documented API version; no create/update/delete. These are referenced BY
>   ID from Managed Systems/Accounts/Directories (`dssKeyRuleId`,
>   `passwordRuleId` fields above), never authored. Stays dropped.
> - **Secret material** (a managed account's `Password`/`PrivateKey`/
>   `Passphrase`, a directory's bind username/password) is never modeled in
>   any of the new config types — Managed Accounts is auto-managed-only, and a
>   Directory's bind credential is a separate BeyondInsight resource entirely.
>   This app never asks an operator to paste a live secret into a canvas
>   field.

> BeyondInsight / Password Safe REST paths follow the public v3 API and should
> be verified against a live BeyondTrust instance — this pass leaned on the
> official API reference and multiple archived API guide versions, but some
> specifics (exact max lengths beyond what's documented, whether
> `DELETE /ManagedSystems/{id}` exists at all, the precise `DELETE /Directories`
> path shape) could not be independently confirmed and are flagged in code.

## 0.2.0 — 2026-08-01

Two more BeyondInsight config types, both driven through the same PS-Auth session
client and pipeline (validate / deploy / rollback / health-check / drift-detect /
status).

- **User Groups** config type — create / list BeyondInsight **user groups**
  (group name, description, active flag) over the BeyondInsight REST API
  (`GET`/`POST` `/UserGroups`, `DELETE /UserGroups/{id}`). Create-if-absent upsert
  matched by name; rollback deletes the groups this deploy created; drift reports
  a missing group (warning) and a differing description / active flag (info).
  Manages **BeyondInsight-type groups only** — Active Directory / LDAP / Entra ID
  groups need a bound directory (a parent graph) and are out of scope. Permissions,
  Smart Rule access and application registrations are **not** managed here; a group
  is created without feature permissions and an admin grants them in BeyondInsight.
- **Workgroups** config type — create / list BeyondInsight **workgroups** (name,
  optional organization GUID) over the BeyondInsight REST API (`GET`/`POST`
  `/Workgroups`). Create-if-absent upsert matched by name; drift reports a missing
  workgroup (warning). Password Safe exposes **no update or delete endpoint** for a
  workgroup, so rollback cannot remove a created workgroup — it reports which ones
  remain for manual removal in the BeyondInsight console.

> **Considered and dropped this release:** *Managed Systems* (`POST /ManagedSystems`
> requires an existing AssetID **or** WorkgroupID plus a PlatformID and
> platform-conditional fields — an un-authorable parent graph) and *Smart Rules*
> (creation requires a full filter/action definition the public API does not model
> as a simple writable body). Both need parent objects that cannot be authored
> generically as-code, so they were left out rather than shipped half-working.

> BeyondInsight / Password Safe REST paths follow the public v3 API and should be
> verified against a live BeyondTrust instance. The exact requiredness of an
> (empty) `Permissions` array on `POST /UserGroups` is unverified and flagged in
> code.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Functional Accounts** config type — create / list Password Safe functional
  accounts (platform ID, account name, domain, display name, description,
  elevation command, optional password) over the BeyondInsight REST API, with
  validate / deploy (create-if-absent upsert) / rollback (delete the accounts this
  deploy created) / health-check / drift-detect / status.
- **Connectivity test** against the BeyondInsight REST API (`POST /Auth/SignAppIn`
  → `POST /Auth/Signout`, HTTPS, self-signed tolerated) using a PS-Auth API key and
  run-as user.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key +
  run-as user → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Password Safe host; saving a connection registers
  `beyondtrust-passwordsafe` as a deploy target).

> BeyondInsight / Password Safe REST paths follow the public v3 API and should be
> verified against a live BeyondTrust instance. Password Safe has **no update (PUT)
> endpoint** for functional accounts, so deploy is create-if-absent — changing an
> existing account means delete + recreate (which loses its stored secret) and is
> never done implicitly. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.
