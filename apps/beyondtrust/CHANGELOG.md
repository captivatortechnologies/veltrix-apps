# Changelog

All notable changes to the BeyondTrust app are documented here.

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
