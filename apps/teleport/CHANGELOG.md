# Changelog

All notable changes to the Teleport app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Teleport (Gravitational) config-as-code app, built research-first directly
against [`gravitational/teleport@master`](https://github.com/gravitational/teleport) source — the
route table in `lib/web/apiserver.go` and the handler files it dispatches to, not documentation
assumptions.

Six configuration types, covering Teleport's clearest declarative, round-trippable surface reachable
through the Teleport **Proxy web API** (the same JSON+YAML surface the Teleport Web UI itself calls —
see README.md for why this app deliberately does not use the gRPC/mTLS transport
`terraform-provider-teleport` and `tctl` use):

- **Roles** (`config-types/roles`) — RBAC roles (`kind: role`) via `/v1/webapi/roles`. Author only the
  role's `spec:` body; the app wraps it into the full resource envelope.
- **GitHub Connectors** (`config-types/github-connectors`) — GitHub SSO auth connectors
  (`kind: github`) via `/v1/webapi/github`. `client_secret` is sensitive — see README's Coverage notes.
- **Trusted Clusters** (`config-types/trusted-clusters`) — cluster federation (`kind: trusted_cluster`)
  via `/v1/webapi/trustedcluster`. The join `token` is sensitive.
- **Machine ID Bots** (`config-types/machine-id-bots`) — bot identities (roles, traits, max session
  TTL) via `/v1/webapi/sites/{site}/machine-id/bot`.
- **Databases** (`config-types/databases`) — dynamic database resource registrations (protocol,
  connection URI, labels, optional AWS RDS metadata) via `/v1/webapi/sites/{site}/databases`. No
  rollback-delete is possible — the web API has no DELETE route for this resource (see README).
- **Discovery Config** (`config-types/discovery-config`) — AWS/Azure/GCP/Kubernetes auto-discovery
  matchers for the Discovery Service via `/v1/webapi/sites/{site}/discoveryconfig`.

Authentication is a local Teleport user's username/password logged in via
`POST /v1/webapi/sessions/web` (the Teleport Web UI's own login call), with the TOTP second factor
computed locally via a zero-dependency RFC 6238 implementation (`lib/totp.ts`) from a base32 seed
bundled into the credential's secret field alongside the password.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
deferred (OIDC/SAML connectors, Access Lists, Login Rules, Access Monitoring Rules, Device Trust,
cluster-wide singleton configs, Locks, Git Servers, and why).
