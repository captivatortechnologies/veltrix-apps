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

The token needs a policy granting `create`/`update`/`delete`/`list` plus **`sudo`** on the `sys/`
paths this app manages: `sys/policies/acl/*`, `sys/policies/rgp/*`, `sys/policies/egp/*`,
`sys/policies/password/*`, `sys/auth/*`, `sys/mounts/*`, `sys/audit/*`, `sys/namespaces/*`,
`sys/quotas/rate-limit/*`, `sys/quotas/lease-count/*`, `sys/plugins/catalog/*`, plus
`identity/entity/*`, `identity/group/*`, `identity/entity-alias/*`, `identity/group-alias/*`,
`identity/mfa/*`. For PKI and Transit, it also needs `create`/`update`/`delete`/`list` on the
`roles`/`keys` paths of every mount it manages (e.g. `pki/roles/*`, `transit/keys/*`) — those are
ordinary mount-scoped paths, not `sys/`. Prefer a periodic or renewable token scoped to exactly
those paths — not a root token.

Register a **`vault-cluster`** component whose hostname is the Vault URL (e.g.
`https://vault.example.com:8200`) and attach the credential. For Vault Enterprise or HCP, set the
namespace in the app settings (sent as `X-Vault-Namespace`) — leave it blank to operate against the
root namespace, which is required for the **Namespaces** config type to manage top-level namespaces.

## Coverage

This app manages Vault's **declarative configuration surface** — the objects a `terraform plan`-style
diff can converge to a desired state. It does not manage Vault's **secret data** — values generated
or supplied at request time (a password, a certificate, an encrypted blob, a leased database
credential) that have no stable "desired state" to converge to. Every config type below states which
side of that line it's on.

### Managed, by sidebar group

| Group | Configuration type | Vault API | Notes |
| --- | --- | --- | --- |
| Policies | ACL Policies | `sys/policies/acl` | Access-control policies, authored in HCL |
| Policies | Password Policies | `sys/policies/password` | Password-*generation* templates (HCL) — distinct from ACL policies |
| Policies | Sentinel Policies | `sys/policies/rgp`, `sys/policies/egp` | RGP (identity-based) / EGP (path-based) governance policies — **Vault Enterprise** |
| Authentication | Auth Methods | `sys/auth` | Auth method mounts + tuning; type is immutable |
| Authentication | MFA Methods | `identity/mfa/method/{type}` | Login MFA method definitions — **Vault Enterprise**; secrets (duo/okta/pingid) are write-only |
| Authentication | MFA Login Enforcement | `identity/mfa/login-enforcement` | Binds MFA methods to logins — **Vault Enterprise** |
| Secrets | Secret Engines | `sys/mounts` | Secret engine mounts + lease tuning; type and KV version are immutable |
| Secrets | PKI Roles | `{mount}/roles` | Certificate **issuance policy** — not the issued certs/keys (secret data) |
| Secrets | Transit Keys | `{mount}/keys`, `{mount}/keys/{name}/config` | Key **existence + configuration** — never the key material itself |
| Identity | Identity Entities | `identity/entity/name` | Policies, metadata, disabled flag |
| Identity | Identity Groups | `identity/group/name` | Internal (explicit members) or external (auth-managed) |
| Identity | Identity Aliases | `identity/entity-alias`, `identity/group-alias` | Binds an external login to an entity/group; reconciled by (mount accessor, name) — an alias has no addressable name |
| Operations | Audit Devices | `sys/audit` | No tuning — a change is disable + re-enable |
| Operations | Rate Limit Quotas | `sys/quotas/rate-limit` | Caps *request rate*; empty path = cluster-wide |
| Operations | Lease Count Quotas | `sys/quotas/lease-count` | Caps *concurrent leases* — **Vault Enterprise** |
| Operations | Namespaces | `sys/namespaces` | Namespace existence + custom metadata — **Vault Enterprise** |
| Operations | Plugins | `sys/plugins/catalog` | External plugin registrations only — never a Vault built-in |

### Excluded, and why (the config-vs-secret-data line)

| Excluded | Reason |
| --- | --- |
| **Secret data itself** — KV values, dynamic/static database credentials, AWS/GCP/Azure dynamic credentials, SSH signed certs/OTPs, transit encrypt/decrypt/sign/verify output, PKI-issued certificates and private keys, per-user TOTP keys | This is the whole point of Vault: values generated or supplied at request time, often leased and rotated, with no stable "desired state" a config-as-code diff can converge to. Never modeled, read, or written by this app. |
| **Transit key material** (the actual cryptographic bytes) | Never returned by *any* Vault API — confirmed in Vault's own docs — and this app has no operation that would touch it. Only the key's *configuration* is managed (Transit Keys, above). |
| **Root/unseal operations** — `sys/init`, unseal, `sys/generate-root`, `sys/rotate` (root key rotation) | One-shot ceremonial operations on the cluster's own trust root. Not configuration. |
| **One-shot cryptographic/issuance operations** — `pki/issue/:role`, `transit/encrypt`, `transit/decrypt`, `transit/rotate`, `transit/sign`, `database/creds/:role`, `aws/creds/:role`, `sys/leases/revoke` | These *do* something once; they don't describe a state to converge to. |
| **Read-only status/health** — `sys/health`, `sys/seal-status`, `sys/leader`, `sys/metrics`, replication status | Surfaced through `healthCheck`, never "deployed" as configuration. |
| **Control Groups** | No standalone declarative endpoint — a Control Group requirement is expressed *inside* an ACL policy's HCL (`control_group` blocks), so it's already covered by the ACL Policies config type's raw HCL body. `sys/control-group/authorize` / `.../request` are one-shot approval operations. |
| **PKI issuer identity/labels** — `pki/issuer/:issuer_ref`, `pki/config/issuers` | An issuer's *existence* is created by a one-shot CA-generation/import operation (`pki/root/generate/*`, `pki/issuers/import/cert`), not a declarative create — only its human labels (`issuer_name`, `leaf_not_after_behavior`, the default issuer) are tunable afterward. Deferred to keep this pass focused on PKI Roles, the cleanly declarative half of PKI config-as-code. |
| **Database / AWS / Kubernetes / SSH secrets-engine roles and connections** | Genuinely declarative, and a natural next step (the same treatment as PKI Roles) — out of scope for this pass, which covers PKI and Transit as the two non-cloud-specific engines. |
| **KV v2 mount-level config** — `{mount}/config` (`max_versions`, `cas_required`, `delete_version_after`) | A genuine small gap, deferred alongside the other secrets-engine surfaces above. |
| **Replication, seal configuration/seal-wrap, license (Enterprise), storage backend config** | Cluster infrastructure set up once at bring-up (typically via the node's own config file, not this HTTP API), not day-2 config-as-code. |

## Safety — Vault imposes real destructiveness

Config-as-code against Vault is not uniformly reversible, and this app is built around that:

- **Disabling a secret engine or auth method destroys its data**, secrets and leases. A rollback that
  removes a mount created by a deploy is therefore destructive, and says so.
- **`type` is immutable** for auth methods, secret engines and Transit keys. If a path/key already
  exists with a *different* type than desired, the deploy **fails** and asks the operator to remove it
  manually — it never disables/deletes and re-creates silently (which would destroy data or mint an
  unrelated key).
- **Audit devices have no tuning** — changing any option means disable + re-enable, and a device
  pointed at an unreachable target (an unwritable file path, a dead syslog/socket) can **block Vault**
  entirely. Audit changes enable the new device before disabling the old, and warn about the window.
- **Deleting a namespace destroys everything inside it** — every mount, policy, auth method and
  secret it contains. Rollback only ever deletes a namespace it created itself.
- **Transit `exportable` and `allowPlaintextBackup` are write-once** — Vault will not let either
  revert to `false` once set `true`. Deploy and drift detection both flag this as unfixable rather
  than silently doing nothing.
- **Built-in objects are never touched**: the `root` and `default` policies, the `token/` auth method,
  and the `sys/`, `identity/`, `cubbyhole/` mounts.

## Health check

Handlers probe `GET /sys/health` (reachable + unsealed + active) and `GET /auth/token/lookup-self`
(the token is valid and unexpired) before doing any work.

## References

- API reference: <https://developer.hashicorp.com/vault/api-docs>
- Policies concepts: <https://developer.hashicorp.com/vault/docs/concepts/policies>
- PKI secrets engine: <https://developer.hashicorp.com/vault/api-docs/secret/pki>
- Transit secrets engine: <https://developer.hashicorp.com/vault/api-docs/secret/transit>
- Identity secrets engine (entities/groups/aliases): <https://developer.hashicorp.com/vault/api-docs/secret/identity>
- Namespaces (Enterprise): <https://developer.hashicorp.com/vault/api-docs/system/namespaces>
- Resource quotas (rate-limit / lease-count): <https://developer.hashicorp.com/vault/docs/concepts/resource-quotas>
- Sentinel policies (Enterprise): <https://developer.hashicorp.com/vault/api-docs/system/policies>
