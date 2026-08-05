# Changelog

All notable changes to the Sophos Central app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added

First release. Eight configuration types covering the genuinely declarative,
round-trippable write surface of the Sophos Central public API
(developer.sophos.com), researched against the live OAS 3.0 documentation:

- **Endpoint Policies** (`endpoint-policies`) — named endpoint policies
  across all 19 documented policy types (threat protection, peripheral/
  application/web control, device encryption, Windows firewall, agent
  updating, DNS protection, and their server-workload equivalents),
  reconciled by (name, type) via `POST/GET/PATCH/DELETE /endpoint/v1/policies`.
  `appliesTo` and `settings` are authored as JSON — Sophos documents their
  shape as "keys have specific names documented here" rather than a fixed
  schema, so this follows the same JSON-blob precedent as Cisco Meraki's
  Group Policies config type.
- **Endpoint Groups** (`endpoint-groups`) — static endpoint groups (name,
  description, endpoint type, member endpoint ids), reconciled by name via
  `POST/GET/PATCH/DELETE /endpoint/v1/endpoint-groups` plus its
  `.../endpoints` membership sub-resource.
- **Scanning Exclusions** (`scanning-exclusions`) — the tenant-wide scanning
  exclusion list (path/POSIX path/virtual path/process/web/PUA/detected
  exploit/AMSI/behavioral/journal-hashing), reconciled by (type, value) via
  `POST/GET/PATCH/DELETE /endpoint/v1/settings/exclusions/scanning`.
- **Allowed Items** (`allowed-items`) — the tenant-wide allow list (path,
  SHA256, certificate signer, POSIX path), reconciled by (type, value) via
  `POST/GET/PATCH/DELETE /endpoint/v1/settings/allowed-items`. Only
  `comment` is patchable after creation.
- **Blocked Items** (`blocked-items`) — the tenant-wide SHA256 block list,
  reconciled by SHA256 via `POST/GET/DELETE /endpoint/v1/settings/blocked-items`
  — Sophos exposes no PATCH for this resource, so a changed item is deleted
  and recreated.
- **Web Control Local Sites** (`web-control-local-sites`) — custom URL ->
  content-category/tag classifications, reconciled by URL via
  `POST/GET/PATCH/DELETE /endpoint/v1/settings/web-control/local-sites`.
- **Exploit Mitigation Exclusions** (`exploit-mitigation-applications`) —
  custom HitmanPro.Alert application path exclusions, reconciled by path via
  `POST/GET/PATCH/DELETE /endpoint/v1/settings/exploit-mitigation/applications`.
- **Custom Roles** (`custom-roles`) — tenant RBAC roles (name, description,
  principal type, permission set grants), reconciled by name via
  `POST/GET/PATCH/DELETE /common/v1/roles`.

Authentication is OAuth2 client-credentials against the global
`https://id.sophos.com/api/v2/oauth2/token` endpoint, followed by a
Who-Am-I (`https://api.central.sophos.com/whoami/v1`) lookup that resolves
the tenant id and its data-region API host — there is no data region setting
to configure by hand, and no "wrong cloud" recovery path is needed (unlike
some other OAuth2-per-region EDR vendors) because the token endpoint and
Who-Am-I are both global. See README.md "Coverage" for what is managed vs.
intentionally excluded.
