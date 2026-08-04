# JumpCloud

Manage [JumpCloud](https://jumpcloud.com/) directory, policy, network-access and
organization configuration as code through the JumpCloud REST API (v1 + v2). Author
configurations in the platform's Configuration Canvas and deploy them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback
are handled per configuration type.

## Credentials

The app authenticates every request with a JumpCloud **API key**, sent as the `x-api-key` header.
Generate one in the JumpCloud Admin Portal under your account name → **My API Key** — the key inherits
the permissions of the admin who owns it, so use an admin scoped to what this app manages.

| Veltrix credential field | JumpCloud value |
| --- | --- |
| API key (API token) | A JumpCloud API key |
| Username (optional) | Org ID — **multi-tenant (MTP) admins only** (sent as `x-org-id`); leave blank for single-tenant |

The API endpoint is **fixed** — JumpCloud is a single global console:

- v1: `https://console.jumpcloud.com/api`
- v2: `https://console.jumpcloud.com/api/v2`

Saving a connection registers a **`jumpcloud-org`** deploy target automatically; no host to configure.

## What it manages

Thirteen configuration types, grouped in the sidebar:

| Group | Configuration type | JumpCloud object | API |
| --- | --- | --- | --- |
| Directory | User Groups | User Groups | `/api/v2/usergroups` |
| Directory | System Groups | System (device) Groups | `/api/v2/systemgroups` |
| Directory | User Group Memberships | User Group membership | `/api/v2/usergroups/{id}/members` |
| Directory | LDAP Server Settings | LDAP-as-a-Service server settings | `/api/v2/ldapservers/{id}` (PATCH only) |
| Policies | Policies | Policy Template instance | `/api/v2/policies` |
| Policies | Policy Groups | Policy Group + member Policies | `/api/v2/policygroups` |
| Access Control | IP Lists | Named IP / CIDR collections | `/api/v2/iplists` |
| Access Control | RADIUS Servers | RADIUS server | `/api/radiusservers` (v1) |
| Access Control | Conditional Access Policies | Authentication Policy | `/api/v2/authn/policies` |
| Automation | Commands | Saved script | `/api/commands` (v1) |
| Organization | Custom Email Configuration | Transactional email override | `/api/v2/customemails` |
| Organization | Password Manager Policies | Org-wide vault policy (singleton) | `/api/v2/passwordmanager/company/policies` |
| Organization | Software Apps (Catalog) | Managed software (catalog-sourced) | `/api/v2/softwareapps` |

### User Groups

One canvas item = one User Group, matched on its **name** (the logical identity used for upsert and
drift). Each deploy:

- lists `GET /api/v2/usergroups` (paged with `limit` + `skip`) and matches by name;
- updates an existing group with `PUT /api/v2/usergroups/{id}` or creates a new one with
  `POST /api/v2/usergroups`, capturing the returned id;
- records each group's id per canvas item so a **rename** updates the same group in place instead of
  creating a duplicate (rename-safe identity), and records the prior body so rollback can restore an
  updated group or delete a created one.

The **membership method** is `STATIC` (membership managed by an administrator) or `DYNAMIC_AUTOMATED`
(JumpCloud derives membership from the group's member query). A dynamic group's member query must be
configured in JumpCloud — this config type does not author it yet, so validate warns when you pick
`DYNAMIC_AUTOMATED`.

### System Groups

One canvas item = one System (device) Group, matched on its **name**. Same upsert / rename-safe /
rollback pattern as User Groups, over `GET/POST /api/v2/systemgroups` and
`PUT/DELETE /api/v2/systemgroups/{id}`. Manages `name` and `description`.

### Policies

One canvas item = one Policy — an **instance of a Policy Template** (`GET /api/v2/policytemplates`)
plus its configuration `values`. Because a Policy is generic over any template, this type already
covers template-driven surfaces such as password complexity or screen-lock requirements without a
dedicated config type for each. Applied over `GET/POST /api/v2/policies` and
`PUT/DELETE /api/v2/policies/{id}`. `values` is authored as a JSON array of
`{ configFieldID, configFieldName, value }` — the template's config-field ids are tenant- and
template-specific, so this type does not attempt to hard-code them.

### User Group Memberships

One canvas item declares the membership of one **existing** User Group, by email / username / raw
user id. Applied over `GET/POST /api/v2/usergroups/{id}/members` (`{ op, type: "user", id }`); members
are resolved to ids via the v1 `GET /api/systemusers` directory. Additive by default; an `exclusive`
flag makes the canvas own the group's full membership.

### LDAP Server Settings

One canvas item manages settings on one **existing** JumpCloud LDAP-as-a-Service server, matched on
its current name: `userLockoutAction` and `userPasswordExpirationAction` (`remove` | `disable`), plus
the name itself (renaming via PATCH). There is **no create or delete** endpoint for LDAP servers in
the JumpCloud API — `GET /api/v2/ldapservers` lists servers provisioned interactively in the Admin
Console, and `PATCH /api/v2/ldapservers/{id}` is the only write. Deploy fails with a clear error if no
server matches the declared name (there is nothing to create).

### Policy Groups

One canvas item = one Policy Group, matched on its **name** — the entire writable surface of the
group object itself (`PolicyGroupData` accepts only `name`, confirmed from the request schema).
Applied over `GET/POST /api/v2/policygroups` and `GET/PUT/DELETE /api/v2/policygroups/{id}`. Each item
also **exclusively owns** the group's member Policy list (declared by Policy name, resolved to ids via
`GET /api/v2/policies`), converged via `GET/POST /api/v2/policygroups/{id}/members`
(`{ op, type: "policy", id }`) — any live member Policy not declared is removed.

### IP Lists

One canvas item = one IP List, matched on its **name**: a description plus the full set of IP
addresses / CIDR ranges. Applied over `GET/POST /api/v2/iplists` and
`GET/PUT/DELETE /api/v2/iplists/{id}`; `PUT` replaces the `ips` array wholesale, so the canvas item
fully owns list membership. IP Lists become access controls once referenced — from a Conditional
Access Policy's `conditions.ipAddressIn`, or from a RADIUS / Admin Portal network-source restriction
configured elsewhere in JumpCloud.

### RADIUS Servers

One canvas item = one RADIUS server, matched on its **name**: network source IP, shared secret, MFA,
auth identity provider, account-lifecycle actions, and certificate/RadSec settings. Applied over the
JumpCloud API **v1** (`GET/POST /api/radiusservers`, `GET/PUT/DELETE /api/radiusservers/{id}`) — the
v2 RADIUS Servers API exposes only association endpoints (bind an existing server to
groups/systems/users), with no create/update/delete for the server object, so this type uses v1 for
the definition itself. `authIdp` is sent on create only (the update model does not accept it, per its
own schema); a FLAGGED API inconsistency means the tag list is sent as `tagNames` on create and `tags`
on update — this type follows whichever name each operation's own schema documents.

The **Shared Secret** is a password-typed field for input hygiene. Unlike other secret-bearing config
types in this codebase, JumpCloud's own API returns `sharedSecret` in its GET responses (verified from
the response schema) — so it is not a true write-only secret at the API level, and rollback restores
the exact prior value it read back before updating. Scope access to this canvas accordingly.

### Conditional Access Policies

One canvas item = one JumpCloud Authentication Policy — JumpCloud's Conditional Access mechanism —
matched on its **name**: which surface it governs (`user_portal` | `application` | `ldap` |
`admin_portal`), allow/deny, an MFA-required obligation, and `targets` / `conditions` authored as raw
JSON (same pattern as the Policies type's `values` field). Applied over
`GET/POST /api/v2/authn/policies` and `GET/PATCH/DELETE /api/v2/authn/policies/{id}`.

The `conditions` grammar (taken verbatim from JumpCloud's own API documentation, and reproduced in the
canvas field's help text) supports `deviceEncrypted`, `deviceManaged`, `ipAddressIn` (referencing IP
List ids from the **IP Lists** config type above), `locationIn` (ISO country codes), and `not` / `all`
/ `any` combinators. `type` is immutable after creation, so it is sent on create only.

### Commands

One canvas item = one Command — a saved script — matched on its **name**: the command text, target
OS, run-as user, sudo, shell, launch type, schedule/trigger, timeout and command-runner users. Applied
over the JumpCloud API **v1** (`GET/POST /api/commands`, `GET/PUT/DELETE /api/commands/{id}`).
Binding a command to specific systems / system groups is **out of scope** — JumpCloud's own API docs
mark the v1 object's `systems` field "Not used. Use /api/v2/commands/{id}/associations to bind
commands to systems", an association-management operation this app does not attempt (same reasoning
as every other association-only surface documented in Coverage below).

### Custom Email Configuration

One canvas item = one transactional email override, identified by its **type** — a fixed 8-value
enum (`activate_gapps_user`, `activate_o365_user`, `lockout_notice_user`, `password_expiration`,
`password_expiration_warning`, `password_reset_confirmation`, `user_change_password`,
`activate_user_custom`) that also serves as the API path segment, so there is no separate id or
rename concern. Manages subject, title, header, body, button label and next-step contact info.
Applied over `POST /api/v2/customemails` (create) and `GET/PUT/DELETE /api/v2/customemails/{type}`.

### Password Manager Policies

A per-tenant **singleton** (exactly one canvas item, no identity field) managing whether users may
export items from their Password Manager vault. Applied over
`GET /api/v2/passwordmanager/company/policies` (returns `{ id, disableExport }`) and
`PUT /api/v2/passwordmanager/company/policies/{id}?disableExport=<bool>` — a **query parameter**, not
a JSON body. `disableExport` is confirmed (from the operation's own parameter list, not inferred) to
be the entire writable surface JumpCloud currently exposes here. Deploy surfaces a clear error if
Password Manager is not enabled for the org (the GET returns 404).

### Software Apps (Catalog)

One canvas item = one JumpCloud-managed software app **sourced from the App Catalog**, matched on its
**displayName**: the App Catalog Installable Id (from `GET /api/v2/software/catalog/apps`),
auto-update, update-delay, desired install state, and an optional display version. Applied over
`GET/POST /api/v2/softwareapps` and `GET/PUT/DELETE /api/v2/softwareapps/{id}`. Custom / private
package uploads (binary artifacts with checksums, download URLs and detection rules, obtained via a
separate `uploadUrl` returned on create) are **intentionally excluded** — that is a binary-artifact
upload workflow, not declarative JSON configuration. See Coverage below.

## Health check

Each configuration type's health check probes a cheap read on its own endpoint — proving the API key
is valid — then confirms every declared object still exists (or, for the two singletons, that the
underlying feature is enabled).

## Coverage

Coverage was audited against JumpCloud's own published OpenAPI 3.1 specifications — the v1 and v2
specs behind `docs.jumpcloud.com`, sourced directly from
`github.com/TheJumpCloud/jumpcloud-docs-public` (`docs/api/1.0/index.yaml`,
`docs/api/2.0/index.yaml`) — cross-checked against the `jcapi-python` client docs for the four
pre-existing config types' conventions.

### Managed declarative configuration

| Configuration type | API operations |
| --- | --- |
| User Groups | `GET/POST /api/v2/usergroups`, `PUT/DELETE /api/v2/usergroups/{id}` |
| System Groups | `GET/POST /api/v2/systemgroups`, `PUT/DELETE /api/v2/systemgroups/{id}` |
| Policies | `GET/POST /api/v2/policies`, `PUT/DELETE /api/v2/policies/{id}` |
| User Group Memberships | `GET/POST /api/v2/usergroups/{id}/members` |
| LDAP Server Settings | `GET /api/v2/ldapservers`, `PATCH /api/v2/ldapservers/{id}` (no create/delete — none exists) |
| Policy Groups | `GET/POST /api/v2/policygroups`, `GET/PUT/DELETE /api/v2/policygroups/{id}`, `GET/POST /api/v2/policygroups/{id}/members` |
| IP Lists | `GET/POST /api/v2/iplists`, `GET/PUT/DELETE /api/v2/iplists/{id}` |
| RADIUS Servers | `GET/POST /api/radiusservers` (v1), `GET/PUT/DELETE /api/radiusservers/{id}` (v1) |
| Conditional Access Policies | `GET/POST /api/v2/authn/policies`, `GET/PATCH/DELETE /api/v2/authn/policies/{id}` |
| Commands | `GET/POST /api/commands` (v1), `GET/PUT/DELETE /api/commands/{id}` (v1) |
| Custom Email Configuration | `POST /api/v2/customemails`, `GET/PUT/DELETE /api/v2/customemails/{type}` |
| Password Manager Policies | `GET /api/v2/passwordmanager/company/policies`, `PUT .../company/policies/{id}?disableExport=<bool>` |
| Software Apps (Catalog) | `GET/POST /api/v2/softwareapps`, `GET/PUT/DELETE /api/v2/softwareapps/{id}` |

### Intentionally excluded

- **SSO Applications** (`/api/v2/applications`) — exposes only association traversal
  (members / user-groups), not full CRUD; creating an SSO application requires a catalog
  template plus complex SSO configuration with no clean write path (dropped in v0.2.0).
- **Directories** (`/api/v2/directories`) — `GET`-only enumeration of active LDAP / Google
  Workspace / Office 365 connector instances. Creating a new connector of any of those
  types requires an interactive OAuth consent flow or (for Active Directory) installing and
  binding an on-premises agent — a bootstrap process, not JSON configuration. The
  per-provider "translation rules" sub-resources (`/api/activedirectories/{id}/translation-rules`,
  `/api/gsuites/{id}/translationrules`, `/api/office365s/{id}/translationrules`) DO have full
  CRUD on an already-connected directory, but are deferred to a future release to keep this
  release's scope to the connector-independent surface.
- **MDM** (Apple / Google Android Enterprise / Microsoft) — Apple MDM setup
  (`POST /api/v2/applemdms`) returns a plist that must be signed by Apple and uploaded back
  (`PUT /api/v2/applemdms/{id}`) — an interactive certificate exchange, not declarative
  config. Google EMM and Microsoft MDM similarly require an enterprise-binding handshake.
  Device enrollment profiles, configuration profiles and command queues fan out to
  device-scale, which this app's single `jumpcloud-org` connection does not model (the same
  reasoning the Cisco Meraki app uses for device-scale resources).
- **Global feature settings** (`/api/v2/feature-settings`) — a generic key/value store
  across the whole catalog of org features, with an untyped, opaque `value` per setting and
  no fixed schema to validate against. Too risky to author blind.
- **Password Policies (legacy)** (`/api/v2/passwordpolicies`) — has create/update/delete by
  id, but **no list endpoint**, making safe upsert-by-identity impossible without already
  knowing the object id. This surface predates JumpCloud's Policy Template system (password
  complexity is now typically authored as a Policy Template via the **Policies** config type
  above); excluded as legacy and unsafe to manage without enumeration.
- **RADIUS / Command / Policy Group / LDAP Server / Software App associations** — every
  "bind this object to a User Group / System Group / System" operation
  (`POST /{resource}/{id}/associations`) is graph-association management, the same
  reasoning User Group Memberships already carved out as its own scoped type rather than a
  generic association manager. Policy Groups' member-**Policy** list is the one exception
  managed here, because it is intrinsic to what a Policy Group *is* rather than a binding to
  an unrelated resource.
- Per-user/device data (Users, Systems, System Insights, Assets), runtime/action endpoints
  (queued command execution, MDM command queues, built-in system power commands,
  `runCommand`) and read-only monitoring (Reports, Identity Risk, Directory Insights,
  Health Monitoring) are outside config-as-code scope — they are either mutable operational
  state, one-shot actions, or observability data, not durable desired configuration.
- Credential / API-key rotation and organization/billing administration are security- and
  business-sensitive control-plane bootstrap, not canvas configuration.

## Verify against a live JumpCloud

API facts were confirmed from JumpCloud's own published OpenAPI 3.1 specifications
(`jumpcloud-docs-public`) — the authoritative source behind `docs.jumpcloud.com` — plus the
JumpCloud API client library docs for the four pre-existing config types. Specific fields flagged in
code comments as unverified against a live tenant:

- **System Groups**: the `description` body field (the public model markdown documents only `name`).
- **Policies**: whether the write model accepts `active` (only the response model documents it), and
  the exact `PolicyValue` wire shape beyond `configFieldID`.
- **User Group Memberships**: the `GraphConnection` / `GraphObject` member shape (`to.id` is assumed),
  and the v1 `/systemusers` list wrapper (`{ results, totalCount }`, limit/skip paging).
- **RADIUS Servers**: the `tagNames` (create) vs `tags` (update) field-name inconsistency, and whether
  `authIdp` can in fact never be changed post-creation.
- **Conditional Access Policies**: whether `PATCH` tolerates a redundant `type` in the body (this
  config type omits it on update to avoid relying on that).
- **Commands**: the exact accepted `launchType` / `scheduleRepeatType` values — JumpCloud's OpenAPI
  spec types these as free strings with no published enum.

## References

- JumpCloud APIs: <https://jumpcloud.com/support/jumpcloud-apis>
- Retrieve object IDs from the API (auth headers): <https://jumpcloud.com/support/retrieve-object-ids-from-the-api>
- JumpCloud API documentation source (OpenAPI 3.1 specs): <https://github.com/TheJumpCloud/jumpcloud-docs-public>
- User Groups API (methods): <https://github.com/TheJumpCloud/jcapi-python/blob/master/jcapiv2/docs/UserGroupsApi.md>

## Development

```
cd apps/jumpcloud
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs jumpcloud              # run handler tests
node ../../scripts/validate-app.mjs apps/jumpcloud       # validate against the app contract
```
