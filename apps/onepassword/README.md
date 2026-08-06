# 1Password

Manage 1Password Business/Team identity and access configuration as code through the self-hosted
**1Password SCIM Bridge**, driven by the Veltrix Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

## Why the SCIM Bridge, and not the Connect API

1Password's public APIs are heavily secret-oriented:

- The **Connect API** (`developer.1password.com` / `1password.dev/connect`) reads and writes vault
  **items** - logins, passwords, API credentials - and only **lists** vaults. There is no `POST` or
  `PATCH` under `/v1/vaults`: vault creation and metadata are not part of its write surface at all.
- The **Events API** is read-only (`GET /api/audit/v1/logs`) - an audit stream, not configuration.
- **Service Accounts** have no REST API for programmatic creation, scoping, or rotation - only the CLI
  and web console manage them.
- The **Users API for Partners** (`1password.dev/users-api`) is a Partner-only, public-preview surface
  (list/get/suspend/reactivate users) that 1Password's own docs state is **not supported alongside
  automated provisioning** - incompatible with the SCIM Bridge this app is built on, and gated to the
  Partner program rather than generally available.

None of these is a genuine, non-secret, round-trippable config-as-code surface. What **is** genuine is
identity/access governance through the **SCIM Bridge** - the same self-hosted integration point
1Password's supported identity providers (Google Workspace, JumpCloud, Microsoft Entra ID, Okta,
OneLogin, Rippling) use to provision users and manage the Groups that grant/revoke vault access
(support.1password.com/scim/). This app speaks to that bridge directly, as a generic SCIM 2.0 client
would - the exact "Groups and group access / vault access grants" + "users/provisioning (SCIM)" surface
called out as worth verifying, and confirmed real.

## What it manages

| Configuration type | SCIM Bridge API | Identity | Notes |
| --- | --- | --- | --- |
| **Users** | `POST/PATCH /Users` | `userName` (email) | Provisions users and manages `active` (suspend/reactivate). Never a password, Secret Key, or vault item - 1Password itself never exposes those over this API. |
| **Groups** | `POST/PATCH /Groups` | `displayName` | Creates custom Groups and full-replaces their `members` set on every deploy - the mechanism 1Password uses to grant/revoke a set of users' access to whichever vaults the group has been given permissions on. |

Both config types use the **standard SCIM 2.0 protocol** (IETF RFC 7643 core schema, RFC 7644 protocol)
that every one of 1Password's supported identity providers speaks to the bridge - not a
1Password-proprietary API:

```
GET    /Users            - ListResponse (urn:ietf:params:scim:api:messages:2.0:ListResponse)
POST   /Users            - create (urn:ietf:params:scim:schemas:core:2.0:User)
PATCH  /Users/{id}       - PatchOp (urn:ietf:params:scim:api:messages:2.0:PatchOp)
GET    /Groups           - ListResponse
POST   /Groups           - create (urn:ietf:params:scim:schemas:core:2.0:Group)
PATCH  /Groups/{id}      - PatchOp (used to full-replace `members`)
GET    /health           - bridge + dependency status (not part of the SCIM schema itself)
```

Bridge capabilities are stated verbatim in 1Password's own deployment guide
(`github.com/1Password/scim-examples`, `PREPARATION.md`, "Considerations"):

> "This integration will create, confirm, and suspend users, and create and manage access to groups."

## Authentication - a self-hosted bridge, and a bearer token

There is no 1Password.com API host to call directly for this surface. The customer deploys their own
**1Password SCIM Bridge** (`github.com/1Password/scim-examples` - Docker, Kubernetes, or a cloud
container platform), which is given a **bearer token** (the `scimsession` credential) during setup - the
same token used by the identity provider integration.

| Veltrix credential field | 1Password value |
| --- | --- |
| API token | The SCIM Bridge's bearer token |

Sent as `Authorization: Bearer <token>` on every request, with body content type
`application/scim+json` (RFC 7644 §3.1). Register an **`onepassword-scim-bridge`** component whose
hostname is the bridge's own base URL (e.g. `https://scim.example.com` - **no trailing slash, no
`/scim/v2` path**), confirmed against two independent, current 1Password IdP setup guides
(`support.1password.com/scim-jumpcloud/`, `support.1password.com/scim-onelogin/`) that both instruct the
admin to enter the bridge's bare domain as the "SCIM connector base URL."

The connectivity test (`GET /health`) is a live, documented example straight from 1Password's own
Kubernetes deployment guide:

```
curl -H "Authorization: Bearer <token>" https://scim.example.com/health
```

returning `{ build, version, reports: [{ source, state }, ...] }` - a 2xx with every `reports[].state`
== `"healthy"` confirms the bridge resolves, the token is valid, and its own dependencies (Redis cache,
SCIM server, provisioning watchers) are up.

## Coverage

What this app manages, what it deliberately does not, and why. Built research-first directly against
`developer.1password.com` (Connect API, Events API, Terraform provider, Users API for Partners, Service
Accounts) and 1Password's own SCIM Bridge sources (`support.1password.com/scim/` and
`github.com/1Password/scim-examples`) - every capability claim above is cited to one of those, not
assumed from other IAM platforms.

### Managed (2 configuration types)

Users, Groups - see the table above for each one's endpoint and identity key.

### Excluded, with reasons

| Surface | Why excluded |
| --- | --- |
| **Vaults** (create/update) | The Connect API only `GET`s vaults - `/v1/vaults` has no `POST`, and `/v1/vaults/{id}` has no `PATCH`/`PUT`. Vault existence and metadata are not part of any public write API. |
| **Secret items** (logins, passwords, API credentials, secure notes, ...) | This is the Connect API's entire purpose, and exactly the secret material this app is built to stay away from - never read, written, or diffed. |
| **Group → Vault permission assignment** (which vaults a group can view/edit) | No confirmed write API. 1Password's SCIM capability is "create and manage access to **groups**" (membership), not a documented endpoint for assigning vault permissions **to** a group - that mapping is configured once, by hand, in the 1Password web console after the group exists. This app manages the group and its membership; the vault-permission grant on the group itself is out of scope. |
| **Hard delete of a User or a Group** | Not documented for the SCIM Bridge. 1Password's own capability statement is "create, confirm, and **suspend** users, and create and manage access to groups" - no delete. Account deletion is described as a manual, permanent, web-console-only action (`support.1password.com/scim/`: "you can still permanently delete their account on 1Password.com"). Removing an item from either canvas therefore does not delete anything; rollback of a resource this app **created** suspends the user or clears the group's membership instead - see "Write-only / non-reversible operations" below. |
| **Service Accounts** (create/scope/rotate) | No REST API exists - only the `op` CLI and the web console manage them (`1password.dev/service-accounts`). |
| **Events API** (`GET /api/audit/v1/logs`) | Read-only by design - an audit stream, not configuration. Not modeled as a configuration type. |
| **Users API for Partners** (`1password.dev/users-api`) | Public-preview and **Partner-program-gated**, not a general Business-tier capability - and 1Password's own docs state it is "not currently supported if you use automated provisioning," which this app's SCIM Bridge integration is. Even its full surface (list/get/suspend/reactivate) is a strict subset of what the SCIM Bridge already covers. |
| **1Password Terraform provider** (`terraform-provider-onepassword`) | Confirmed to manage **items** (logins, passwords, database credentials) via the Connect API - the same secret-item surface this app excludes, not an additional vault/group surface. |
| **Automated Provisioning (hosted)** for Entra ID / Okta | 1Password now offers a newer, 1Password-hosted provisioning path for these two identity providers as an alternative to self-hosting the SCIM Bridge. It has no separate, independently documented API surface of its own (distinct from the bridge) in the sources available to this app - Google Workspace, JumpCloud, OneLogin, and Rippling still use the SCIM Bridge modeled here. |

### Write-only / non-reversible operations, explicit

- **User suspend, not delete**: rollback of a user this app **created** issues `PATCH active: false`
  (suspend), never a delete. The account and its data remain until an operator removes it permanently in
  the 1Password web console, if that's truly intended.
- **Group membership clear, not delete**: rollback of a group this app **created** issues
  `PATCH members: []` (clears every member), never a delete. The group object remains.
- **Neither of the above is a workaround for a missing DELETE endpoint this app chooses not to call** -
  no DELETE is documented for either resource on the SCIM Bridge at all.
- **Never a secret**: neither config type ever reads, writes, stores, or diffs a master password, Secret
  Key, or any vault item. 1Password's own architecture makes this structural, not a rule this app
  chooses to follow - the SCIM Bridge's schema has no such field to touch.

## Development

```bash
cd apps/onepassword
node node_modules/typescript/bin/tsc --noEmit        # typecheck
node ../../scripts/test-apps.mjs onepassword         # unit tests
node ../../scripts/validate-app.mjs apps/onepassword # contract validation
```

## References

- Connect API reference: <https://developer.1password.com/docs/connect/connect-api-reference/>
- Events API reference: <https://developer.1password.com/docs/events-api/reference/>
- Service Accounts overview: <https://developer.1password.com/docs/service-accounts/>
- Users API for Partners: <https://developer.1password.com/docs/users-api/>
- SCIM Bridge overview: <https://support.1password.com/scim/>
- SCIM Bridge deployment examples: <https://github.com/1Password/scim-examples>
- SCIM 2.0 core schema: [RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643)
- SCIM 2.0 protocol: [RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644)
