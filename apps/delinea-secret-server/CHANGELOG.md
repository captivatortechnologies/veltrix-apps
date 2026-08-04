# Changelog

All notable changes to the Delinea Secret Server app are documented here.

## 0.3.0 — 2026-08-04

Five new configuration types, exhausting the genuinely-declarative,
non-secret-bearing surface of the Secret Server REST API. Every type is a
full pipeline unit (validate / deploy / rollback / health-check / drift-detect
/ status) over the same OAuth2 password-grant REST client as the existing
types, reusing `lib/secretServerApi.ts`'s shared `listAllRecords` /
`normalizeBool` / `secretServerErrorMessage` helpers. All eight configuration
types are now grouped in the sidebar: **Vault Structure** (Folders, Secret
Policies), **Access & Identity** (Groups, Users, IP Address Restrictions) and
**Distributed Engines** (Sites, Connection Managers, Distributed Engine
Configuration).

- **Sites** config type — create / update Distributed Engine sites (name,
  engine callback interval, Site Connector assignment, WinRM/CredSSP, RDP/SSH
  proxy) over the Secret Server REST API
  (`/api/v1/distributed-engine/site[s]`). Upsert by site name. A
  `powershellRunAsSecretId` field is a plain ID *reference* to an existing
  secret (never its contents).
- **Connection Managers** config type — create / update Secret Server's Site
  Connectors (name, hostname, transport type, port, TLS) over
  `/api/v1/distributed-engine/site-connector[s]`. Upsert by name. Never reads
  or writes the connector's own service-account credential exposed at
  `GET .../site-connector/{id}/credentials` — that is secret material and
  out of scope. FLAGGED: the module's create field is `siteConnectorName` but
  its update field is `name` for the same value — both are honored; verify
  against a live instance.
- **IP Address Restrictions** config type — create / update named IP
  address restrictions / allowed IP ranges (name + CIDR or single IP) over
  `/api/v1/ipaddress-restrictions`. Upsert by name. No secret material of any
  kind. Scope is the named ranges themselves; attaching a restriction to a
  user or group is not implemented (see README Coverage).
- **Distributed Engine Configuration** config type — a tenant-wide
  **singleton** (`repeatable: false`) over
  `GET`/`PATCH /api/v1/distributed-engine/configuration`: feature enablement,
  transport/protocol, callback URL/port, response-bus connector reference and
  secret-heartbeat/password-change message timing. No create/delete — this
  object always exists.
- **Users** config type — reconciles **profile attributes only**
  (display name, email, active state, application-account flag) for
  **EXISTING** Secret Server users over `/api/v1/users`. **No password field,
  by design**: creating a local user requires setting a password over this
  REST API, and storing/rotating a password as canvas config is a
  secret-handling anti-pattern this PAM app must not commit (the same
  judgment call already applied to `splunk-cloud`'s Users config type). A
  user that does not exist is a hard deploy failure with a clear message; a
  user backed by Active Directory is skipped (its profile belongs to the
  directory, mirroring the existing Groups `isSynchronizedGroup` guard).

> Endpoints and field names were verified against the Delinea/Thycotic
> `Thycotic.SecretServer` PowerShell module source
> (`thycotic-ps/thycotic.secretserver`), which wraps the documented Secret
> Server v1 REST API: `New/Set/Get/Search-TssDistributedEngineSite`,
> `New/Set/Get/Search-TssDistributedEngineSiteConnector`,
> `New/Update/Search-TssIpRestriction`, `Get/Set-TssDistributedEngine`
> (the `/distributed-engine/configuration` singleton), and
> `New/Update/Search/Get-TssUser`. Several genuinely-declarative candidates
> were **researched and explicitly dropped** — see the README Coverage
> section for the full list and reasons (Roles: read/search-only REST
> surface, no create/update endpoint exists; Secret Templates: creation
> requires a full password-field schema in one call and update only exposes
> an `active` toggle; Secret Policy Assignments: the only exposed field lives
> on a legacy, differently-shaped endpoint this app does not otherwise use;
> Event Subscriptions/Webhooks: no create endpoint for pipelines or policies
> exists, and pipeline definitions carry destination credentials). TLS
> verification stays off by default (on-prem self-signed) and configurable
> via the `verify_tls` setting.

## 0.2.0 — 2026-08-01

Two new configuration types, each a full pipeline unit (validate / deploy /
rollback / health-check / drift-detect / status), driven over the same OAuth2
password-grant REST client as folders.

- **Secret Policies** config type — create / update Secret Server secret policies
  (policy name, description, active state) over the Secret Server REST API
  (`/api/v1/secret-policy`). Upsert by policy name: search
  (`GET /api/v1/secret-policy/search?filter.secretPolicyName=…`), create
  (`POST /api/v1/secret-policy` with a `{ data: { … } }` body), update
  (`PATCH /api/v1/secret-policy/{id}` with the policy grid-patch
  `{ data: { <field>: { dirty, value } } }`). Rollback restores the prior policy
  body; a newly created policy is left in place. Requires Secret Server
  11.0.000005+.
- **Groups** config type — create / update Secret Server local groups (group
  name, enabled state) over the Secret Server REST API (`/api/v1/groups`). Upsert
  by group name: search (`GET /api/v1/groups?filter.searchText=…`), create
  (`POST /api/v1/groups` with `{ name, enabled }`), update
  (`PUT /api/v1/groups/{id}`). A group synchronized from Directory Services is
  skipped (managed in the directory). Rollback restores the prior group body; a
  newly created group is left in place.
- **Shared list helpers** (`lib/secretServerApi.ts`) — generic
  `recordsFromResponse` / `listAllRecords` / `normalizeBool` reused by both new
  config types (single implementation of the `{ records, total }` envelope +
  skip/take paging).

> Endpoints and field names were verified against the Delinea/Thycotic
> `Thycotic.SecretServer` PowerShell module source (New/Set/Get/Search-TssSecretPolicy,
> New/Get/Search-TssGroup), which wraps the documented Secret Server v1 REST API.
> Two paths remain **UNVERIFIED against a live instance** and are flagged in code:
> (1) the secret-policy PATCH `active`-field placement/casing within the
> `{ dirty, value }` grid-patch, and (2) the group update verb/path
> (`PUT /api/v1/groups/{id}`) — the PowerShell module exposes no group-update
> cmdlet. Verify both against a live Secret Server. TLS verification stays off by
> default (on-prem self-signed) and configurable via the `verify_tls` setting.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Folders** config type — create / update Secret Server folders (folder name,
  parent folder, permission inheritance, secret-policy inheritance) over the
  Secret Server REST API (`/api/v1/folders`), with validate / deploy (upsert by
  folder name within a parent) / rollback (restore prior state) / health-check /
  drift-detect / status.
- **Connectivity test** against the Secret Server REST API — runs the OAuth2
  password grant (`POST <base>/oauth2/token`) then a lightweight authorized probe
  (`GET /api/v1/folders?take=1`). HTTPS, self-signed tolerated.
- **API seam** (`lib/secretServerApi.ts`) — OAuth2 password-grant bearer-token
  client over `node:https` (self-signed tolerated, toggled by the `verify_tls`
  setting), token cached for the handler's lifetime.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API user
  → connection → author), and Connections (wraps the SDK `ConnectionsManager` for
  a Secret Server instance; saving a connection registers `delinea-secret-server`
  as a deploy target).

> Secret Server REST API paths and folder fields (`/api/v1/folders`,
> `oauth2/token`, `folderName` / `parentFolderId` / `inheritPermissions` /
> `inheritSecretPolicy` / `folderTypeId`) follow the documented v1 REST API and
> should be verified against a live Secret Server instance. TLS verification is
> off by default (on-prem self-signed) and configurable via the `verify_tls`
> setting.
