# Check Point (Veltrix app)

Manage [Check Point](https://www.checkpoint.com) Security Management Server
configuration as code through the **Check Point Management API**
(`web_api`), driven by the Veltrix Security-as-Code pipeline (validate →
deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | Check Point object | Management API commands |
| --- | --- | --- |
| **Network Hosts** (`network-hosts`) | Host objects | `show-hosts` / `show-host` (list/read), `add-host`, `set-host`, `delete-host` |

Reconciles by object **name** and targets a `checkpoint-management` component.

## Session model — login, publish, discard, logout

Every Management API write is a **session**: log in, make one or more
changes, then either **publish** them together or **discard** the whole
session on any error. This app treats one deploy/rollback as exactly one
session, so a partial failure never leaves a half-applied configuration
published:

1. `POST /web_api/login` — `{ user, password }` or `{ api-key }` → `{ sid }`
2. Every subsequent call carries `X-chkp-sid: <sid>`
3. `POST /web_api/add-host` / `set-host` / `delete-host` for each reconciled
   host object
4. On success: `POST /web_api/publish` commits every change together
5. On any error: `POST /web_api/discard` throws the whole session away
6. `POST /web_api/logout` always ends the session

Publishing here does **not** install a security policy on a gateway — it only
commits object changes to the management database, the same effect as
clicking **Publish** in SmartConsole.

### Network hosts

Deploy lists the management database (`show-hosts`, paginated 500/page),
matches declared items by `name`, and reconciles:

- missing hosts → `add-host`
- existing hosts → `set-host` (always applied, so drift in fields the canvas
  doesn't manage is left alone but every managed field is set to the declared
  value)
- hosts this app created in a **prior successful deploy** but no longer
  declares → `delete-host`

Each host declares an IPv4 and/or IPv6 address (at least one required),
optional comments, an optional color (validated by Check Point itself — see
the object color picker in SmartConsole for the full list), and optional
tags. Rollback restores each updated host's prior managed fields and removes
hosts this app created, then publishes that reversal as its own session.

## Authentication

Either of:

- **Username + password** — a Check Point administrator account. Store the
  username in the credential **Username** field and the password in
  **Password**.
- **API key** — SmartConsole **Object Explorer → New → API Key** (or
  `mgmt_cli add api-key`). Store it in the credential **API token** field.
  When present, the API key is used instead of username/password.

The administrator (or the API key's owning admin) needs a permission profile
that can read and write network objects.

## Component

Register a `checkpoint-management` component whose **hostname** is the same
Management Server address SmartConsole connects to. Management API requests
go to `https://<host>:<port>/web_api/<command>` (unversioned by default).

## TLS

An on-prem Security Management Server commonly ships a **self-signed
certificate** for `web_api` / SmartConsole. This app talks to it over
`node:https` with its own `https.Agent`, independent of the platform's global
`fetch` — so **Verify TLS certificate** genuinely controls whether the
certificate is checked (off by default). Turn it on once a CA-signed
certificate is installed.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `port` | `443` | Management API HTTPS port. |
| `verify_tls` | `false` | Enforce a valid TLS certificate on the Management Server. |
| `domain` | _(none)_ | Multi-Domain Security Management only — the Domain Management Server / CMA to log into. |
| `request_timeout_seconds` | `30` | Per-request timeout for Management API calls. |

## References

- [Check Point Management API Reference](https://sc1.checkpoint.com/documents/latest/APIs/) — session model, `add-host` / `set-host` / `delete-host` / `show-host(s)` command reference.
- [cp_mgmt_api_python_sdk](https://github.com/CheckPointSW/cp_mgmt_api_python_sdk) — Check Point's own Management API SDK; used to verify the login/`X-chkp-sid`/publish/discard/logout mechanics and the HTTP-200-only success rule.
- [CheckPointAnsibleMgmtCollection](https://github.com/CheckPointSW/CheckPointAnsibleMgmtCollection) — `cp_mgmt_host` / `cp_mgmt_host_facts` modules; used to verify the host object's field set.
- [terraform-provider-checkpoint](https://github.com/CheckPointSW/terraform-provider-checkpoint) — `resource_checkpoint_management_host.go`; used to verify the exact `add-host`/`set-host` payload keys (`ipv4-address`, `ipv6-address`, `comments`, `color`, `tags`).

### Not modeled in v0.1.0 (flagged, not faked)

- **Group membership**, **NAT settings**, **host servers** (DNS/mail/web
  authentication roles) and **multi-interface hosts** are real host-object
  properties but were dropped from this first version to keep it a genuinely
  self-contained object with no dependency on another object (a group, a
  gateway to install NAT on). A future `network-host-groups` (and similar)
  config type is the natural place for group membership.
- The exact enumerated list of valid `color` values could not be verified
  against a live server for this release, so `color` is a free-text field
  passed straight through — Check Point's own `add-host`/`set-host` response
  is the source of truth if an unrecognized value is rejected.

## Development

```
cd apps/checkpoint
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs checkpoint        # run handler tests
node ../../scripts/validate-app.mjs apps/checkpoint # validate against the app contract
```
