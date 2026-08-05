# SentinelOne

Manage [SentinelOne](https://www.sentinelone.com/) endpoint security configuration as code through
the SentinelOne Management API (v2.1). Author configurations in the platform's Configuration Canvas
and deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback are handled per configuration type.

## Credentials

Create a **service-user API token** in the SentinelOne console (**Settings → Users**) scoped at the
level this app manages, and store it as a Veltrix credential:

| Veltrix credential field | SentinelOne value |
| --- | --- |
| API token | The service-user API token |

The token inherits its user's role and scope, so use a token scoped at the highest level it must
manage. Every request is sent as `Authorization: ApiToken <token>` to
`https://<console>.sentinelone.net/web/api/v2.1`.

Register a **`sentinelone-console`** component whose hostname is your management console URL (e.g.
`acme.sentinelone.net`). Set the **Scope** app setting (`global`, `account`, `site` or `group`) and
the **Scope ID** (the matching account/site/group id; not needed for `global`).

## What it manages

| Configuration type | Object | Endpoint |
| --- | --- | --- |
| Exclusions | Path / file-type / hash / certificate / browser exclusions | `/exclusions` |
| Blocklist Hashes | `black_hash` block entries | `/restrictions` |
| Hash Allowlist | `white_hash` allow entries | `/restrictions` |
| STAR Rules | S1QL 2.0 custom detection rules | `/cloud-detection/rules` |
| Agent Policy | The per-scope agent policy | `/{scope}/{id}/policy` |
| Groups | Static / dynamic agent groups | `/groups` |
| Firewall Control | Network firewall rules (Control SKU) | `/firewall-control` |
| Device Control | USB / Bluetooth peripheral rules | `/device-control` |
| Notification Recipients | Alert email/SMS recipients | `/settings/recipients` |
| RBAC Roles | Custom RBAC roles + permission overrides | `/rbac/roles`, `/rbac/role`, `/rbac/role/{id}` |

See [Coverage](#coverage) below for what's deliberately out of scope and why.

## SentinelOne-specific behaviour the app handles

- **Account → Site → Group scoping.** Collections carry the scope inside the request body's `filter`
  (`accountIds`/`siteIds`/`groupIds`, or `tenant:true` for global); the agent policy carries scope in
  the path. The app resolves the `Scope` + `Scope ID` settings into both forms.
- **The agent policy is a per-scope singleton.** There is no "no policy" state — the app reads the
  current policy, merges the authored keys, and PUTs the merged object (read-modify-write), and
  supports revert-to-inherit rather than delete.
- **Envelope + cursor pagination.** Responses use `{ data, pagination, errors }`; the app follows
  `pagination.nextCursor` and surfaces `errors[]` on failure. Honors 429 with backoff.
- **Identity that survives environments.** Exclusions match on `type`+`value`+`osType`+scope (no
  server key); blocklist/allowlist on the hash + scope (add/remove, no update); STAR rules, Firewall
  Control rules and Device Control rules track the server id but reconcile by `name`
  (case-insensitive; SentinelOne does not enforce name uniqueness itself); groups on `name` within a
  site; notification recipients on `email`; RBAC roles on `name`.
- **Protected objects.** Predefined (`source ≠ user`) exclusions/restrictions and the auto-created
  Default Group are never modified or deleted.
- STAR rules are created as `Draft` (S1QL 2.0) and then enabled.
- **Firewall Control requires the Control SKU**; rules are evaluated in order and unmatched traffic is
  allowed by default, so a deliberate catch-all rule should be declared last for a default-deny
  posture.
- **Notification recipients are account/site/global only** — there is no group-scoped
  `/settings/recipients` endpoint, so this config type refuses the `group` scope.
- **RBAC roles use a read-merge-write on permissions, exactly like the Agent Policy config type.**
  SentinelOne's per-role permission tree is deep, tenant/SKU-specific and undocumented in any public
  source, so this app never hardcodes it. Instead, authors declare only the dot-path permission keys
  they want to set; deploy merges those into the scope's new-role template (`GET /rbac/role`, for a
  role being created) or the role's current permissions (`GET /rbac/role/{id}`, for a role being
  updated) and writes the merged tree back. Discover the keys your tenant supports from either of
  those two GET responses.

## Health check

Handlers make a cheap authenticated read at the configured scope to prove the token + scope work
before doing any work, then confirm each declared object is present.

## Coverage

**Managed** (10 configuration types, all validated / deployed / drift-detected / rolled back through
the pipeline):

| Object | Endpoint | Why it's config-as-code |
| --- | --- | --- |
| Exclusions | `/exclusions` | Declarative, round-trippable, no secrets |
| Blocklist / allowlist hashes | `/restrictions` | Declarative, round-trippable (additive), no secrets |
| STAR custom detection rules | `/cloud-detection/rules` | Declarative, round-trippable, no secrets |
| Agent policy | `/{scope}/{id}/policy` | Declarative singleton, round-trippable, no secrets |
| Groups | `/groups` | Declarative, round-trippable, no secrets |
| Firewall Control rules | `/firewall-control` | Declarative, round-trippable, no secrets (Control SKU) |
| Device Control rules | `/device-control` | Declarative, round-trippable, no secrets |
| Notification recipients | `/settings/recipients` | Declarative, round-trippable, no secrets |
| RBAC custom roles | `/rbac/roles` (+ `/rbac/role`, `/rbac/role/{id}`) | Declarative via read-merge-write on permissions, no secrets |

**Intentionally excluded** (sourced and reasoned, not oversights):

| Surface | Why it's out of scope |
| --- | --- |
| Response actions (isolate / disconnect network / initiate scan / mitigate / remediate / rollback threat) | One-shot imperative actions on a live agent/threat, not a persistent declarative object — nothing to diff or drift-detect |
| Threats, alerts, activities, Deep Visibility events | Read-only telemetry/case data generated by the product, not authored configuration |
| Agent install packages, upgrade packages (`/update/*`) | Distributed binaries, not configuration; agent version enforcement belongs to the Agent Policy / Auto-Upgrade Policy surface, not a file to manage as code |
| Sites (`/sites`) | Endpoint genuinely exists (create/update/list all confirmed), but site creation/updates are entangled with commercial license-pool allocation (`totalLicenses`/`siteType`/`sku`/`expiration`) whose exact write-body semantics could not be verified against an authoritative source. Mutating a customer's license pool on an unverified schema is a correctness risk this app declines to take; Sites remain console-managed. Revisit if SentinelOne publishes the public schema. |
| SMTP / SSO / Active Directory settings (`/settings/smtp`, `/settings/sso`, `/settings/active-directory`) | Carry secret material (SMTP credentials, SAML signing certs/keys, AD bind credentials) — excluded per this app's no-secrets policy |
| Syslog forwarding settings (`/settings/syslog`) | Endpoint exists, but the write-body schema (host/port/protocol vs. optional mutual-TLS client certificate/key) could not be verified from an authoritative source, and a client certificate would be secret material if present. Deferred rather than guessed |
| Scheduled reports (`/reports`, `/report-tasks`) | Endpoints exist, but no verifiable field-level write schema was found; deferred rather than guessed |
| Ranger / Ranger Deploy / Ranger Self-Enablement (attack surface management) | A separate product surface (rogue/unmanaged-asset discovery) with its own enablement and credential-group model that was not part of this pass's scope |
| Marketplace app installs (`/marketplace`) | Installs third-party integrations with their own config schemas per app — out of scope for this app |
| User accounts (`/users`) | User lifecycle/identity management, not endpoint security configuration; also touches PII |

## References

- SentinelOne Management API: `https://<console>.sentinelone.net/api-doc/` (per-tenant Swagger)
- STAR / S1QL: <https://www.sentinelone.com/blog/>
- Firewall Control / Device Control / RBAC endpoint existence, filter and field names:
  [Celerium/SentinelOne-PowerShellWrapper](https://github.com/Celerium/SentinelOne-PowerShellWrapper)
  (`Get-SentinelOneFirewallRules`, `Get-SentinelOneDeviceControlRules`, `Get-SentinelOneRBACRoles`,
  `Get-SentinelOneRBACRoleTemplate`, `Get-SentinelOneSites`, `Get-SentinelOneSettings`,
  `Get-SentinelOneSettingEmailRecipients`) and the SentinelOne Postman workspace
  (`api-evangelist/sentinelone`) "Create Firewall Rule" / "Get Firewall Rules" / "Delete Firewall
  Rules" / "Create Device Control Rule" requests
- RBAC feature overview: <https://www.sentinelone.com/blog/feature-spotlight-fully-custom-role-based-access-control/>
- Firewall Control feature overview: <https://www.sentinelone.com/blog/feature-spotlight-firewall-control/>
- Device Control feature overview: <https://www.sentinelone.com/blog/feature-spotlight-device-control/>
