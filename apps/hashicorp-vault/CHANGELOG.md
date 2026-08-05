# Changelog

All notable changes to the HashiCorp Vault app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-08-05

### Added
Six new configuration types, closing the remaining genuinely declarative gaps in
the Vault HTTP API (research-first exhaustion pass — see README's Coverage
section for the full managed-vs-excluded breakdown and the config-vs-secret-data
line this app draws):

- **PKI Roles** — certificate issuance policy for a PKI secrets engine mount
  (`{mount}/roles/{name}`). Issued certificates and private keys are secret data
  and are never modeled, read or written here.
- **Transit Keys** — a Transit key's existence and configuration (`{mount}/keys/
  {name}` + `.../config`): type, derivation, exportability, deletion policy,
  key-version bounds and rotation cadence. The key material itself is generated
  by Vault, is never returned by any Vault API, and this app never reads,
  writes, or exports it.
- **Identity Aliases** — bind an external login (auth mount accessor + name) to
  an identity entity or group via `/identity/entity-alias` and `/identity/
  group-alias`, reconciled the same way login-MFA methods are (label match, no
  addressable name).
- **Sentinel Policies** — RGP (identity-based) and EGP (path-based) governance
  policies via `/sys/policies/rgp` and `/sys/policies/egp` (Vault Enterprise).
- **Namespaces** — namespace existence and custom metadata via `/sys/namespaces`
  (Vault Enterprise). Deleting one destroys everything provisioned inside it.
- **Lease Count Quotas** — concurrent-lease caps via `/sys/quotas/lease-count`
  (Vault Enterprise), alongside the existing request-rate Rate Limit Quotas.

### Changed
- `lib/vault.ts`: the shared client now supports `PATCH` (a real RFC 7396 JSON
  merge patch, used only by `/sys/namespaces`) with its own content type,
  distinct from the existing POST/PUT write path.
- Updated `MISSING_CREDENTIAL_MESSAGE` to list the additional `sys/` paths (and
  the PKI/Transit mount-relative paths) the six new configuration types need
  sudo/write access to.

## 1.3.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 5 collapsible sections — Policies,
  Authentication, Secrets, Operations, and Identity — so all 11 configuration
  types stay navigable. Sections collapse by default, remember whether you left
  them open, and always expand the one you're currently working in.
