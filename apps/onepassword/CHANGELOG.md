# Changelog

All notable changes to the 1Password app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the 1Password config-as-code app, built research-first against
[developer.1password.com](https://developer.1password.com/) (Connect API, Events API, Terraform
provider, Users API for Partners, Service Accounts) and 1Password's own SCIM Bridge sources
(`support.1password.com/scim/`, `github.com/1Password/scim-examples`).

1Password's public write surface is almost entirely secret-oriented - the Connect API reads/writes
vault items and only lists vaults (no create/update); the Events API is read-only; Service Accounts have
no REST API; and the Users API for Partners is Partner-gated, public-preview, and explicitly incompatible
with automated provisioning. None of these is a genuine config-as-code surface. What is genuine, and
what this release covers, is identity/access governance through the self-hosted **1Password SCIM
Bridge** - the same integration point 1Password's supported identity providers use to provision users
and manage the Groups that grant/revoke vault access:

- **Users** (`config-types/users`) — provisions users (email, name) and manages their active/suspended
  status via standard SCIM 2.0 `POST`/`PATCH /Users`, matched by `userName` (email). Never touches a
  password, Secret Key, or vault item.
- **Groups** (`config-types/groups`) — creates custom Groups and full-replaces their membership via
  `POST`/`PATCH /Groups`, matched by `displayName` — 1Password's own "create and manage access to
  groups" capability, and the mechanism that grants/revokes a set of users' access to whichever vaults
  the group has been given permissions on.

Authentication is the SCIM Bridge's own bearer token (the `scimsession` credential), sent as
`Authorization: Bearer <token>` with `application/scim+json` bodies per RFC 7644 §3.1. The connection's
endpoint is the bridge's own base URL (no `/scim/v2` path - confirmed against two independent, current
1Password IdP setup guides), and the connectivity test calls the bridge's documented `GET /health`
status endpoint.

Neither config type exposes a delete: 1Password's own capability statement is "create, confirm, and
suspend users, and create and manage access to groups" - no delete is documented for either resource.
Rollback of a resource this app created suspends the user or clears the group's membership instead of
deleting anything, consistent with what the bridge actually supports.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
confirmed non-viable (Vaults create/update, secret items, Service Accounts REST, Events API) or
deliberately out of scope (Group → Vault permission assignment, hard delete, the Partner-only Users API).
