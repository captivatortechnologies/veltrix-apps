# HashiCorp Vault

Manage [HashiCorp Vault](https://www.vaultproject.io/) configuration as code through the Vault HTTP
API. Author configurations in the platform's Configuration Canvas and deploy them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback are handled
per configuration type.

## Credentials

The app authenticates every request with a Vault token, sent as `X-Vault-Token`. Store the token as
a Veltrix credential:

| Veltrix credential field | Vault value |
| --- | --- |
| API token | A Vault token |

The token needs a policy granting `create`/`update`/`delete` plus **`sudo`** on the `sys/` paths this
app manages: `sys/policies/acl/*`, `sys/auth/*`, `sys/mounts/*`, `sys/audit/*`. Prefer a periodic or
renewable token scoped to exactly those paths — not a root token.

Register a **`vault-cluster`** component whose hostname is the Vault URL (e.g.
`https://vault.example.com:8200`) and attach the credential. For Vault Enterprise or HCP, set the
namespace in the app settings (sent as `X-Vault-Namespace`).

## What it manages

| Configuration type | Vault object | API |
| --- | --- | --- |
| ACL Policies | ACL policies authored in HCL | `sys/policies/acl` |
| Auth Methods | Auth method mounts + tuning | `sys/auth` |
| Secret Engines | Secret engine mounts + tuning | `sys/mounts` |
| Audit Devices | Audit devices | `sys/audit` |

## Safety — Vault imposes real destructiveness

Config-as-code against Vault is not uniformly reversible, and this app is built around that:

- **Disabling a secret engine or auth method destroys its data**, secrets and leases. A rollback that
  removes a mount created by a deploy is therefore destructive, and says so.
- **`type` is immutable** for auth methods and secret engines. If a path already exists with a
  *different* type than desired, the deploy **fails** and asks the operator to remove it manually — it
  never disables and re-enables silently (which would destroy data).
- **Audit devices have no tuning** — changing any option means disable + re-enable, and a device
  pointed at an unreachable target (an unwritable file path, a dead syslog/socket) can **block Vault**
  entirely. Audit changes enable the new device before disabling the old, and warn about the window.
- **Built-in objects are never touched**: the `root` and `default` policies, the `token/` auth method,
  and the `sys/`, `identity/`, `cubbyhole/` mounts.

## Health check

Handlers probe `GET /sys/health` (reachable + unsealed + active) and `GET /auth/token/lookup-self`
(the token is valid and unexpired) before doing any work.

## References

- API reference: <https://developer.hashicorp.com/vault/api-docs>
- Policies concepts: <https://developer.hashicorp.com/vault/docs/concepts/policies>
