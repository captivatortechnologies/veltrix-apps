# Changelog

All notable changes to the Cato Networks app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Cato Networks (SASE/SSE) config-as-code app, built research-first against
`cato_api.graphqls` - the GraphQL schema Cato's own generated Go SDK
([`catonetworks/cato-go-sdk`](https://github.com/catonetworks/cato-go-sdk)) and Terraform provider
(`catonetworks/terraform-provider-cato`) are both built from/against, and the same schema behind
[api.catonetworks.com/documentation](https://api.catonetworks.com/documentation/).

Nine configuration types, covering the core declarative surface of the Cato Management Application
(CMA) GraphQL API:

- **Internet Firewall Sections / Rules** (`config-types/internet-firewall-{sections,rules}`) -
  outbound internet-bound traffic policy, full section + rule lifecycle, via
  `policy(accountId).internetFirewall`.
- **WAN Firewall Sections / Rules** (`config-types/wan-firewall-{sections,rules}`) -
  site-to-site/datacenter traffic policy (adds `direction`), via `policy(accountId).wanFirewall`.
- **Application Control Rules** (`config-types/application-control-rules`) - CASB-style
  application/data/file rule kinds via `policy(accountId).applicationControl`.
- **TLS Inspection Rules** (`config-types/tls-inspection-rules`) - which traffic gets decrypted and
  untrusted-certificate handling, via `policy(accountId).tlsInspect`.
- **Anti-Malware File Hash Rules** (`config-types/anti-malware-file-hash-rules`) - per-file
  block/bypass exceptions by SHA-256, via `policy(accountId).antiMalwareFileHash` - the one
  genuinely declarative slice of Cato's broader IPS/anti-malware/threat-prevention surface.
- **Custom Applications** (`config-types/custom-applications`) - reusable destination +
  port/protocol objects referenced by name from policy rules, via `customAppData(accountId)`.
- **Network Ranges** (`config-types/network-ranges`) - account-wide Global IP Range network
  objects referenced by name from policy rules, via `object(accountId)`.

**Staged config model**: Internet/WAN Firewall, Application Control, TLS Inspection and Anti-Malware
File Hash all write into the calling admin's private draft revision; deploy performs every
add/update/remove/move mutation then calls `publishPolicyRevision` once. Rollback replays the
previous canvas version's own declared spec (never a live re-read - Cato's read/write ref shapes
differ) and republishes, mirroring `wiz-integrations`'s handling of the same problem elsewhere in
this codebase. Custom Applications and Network Ranges apply immediately (no publish step exists for
either in the schema).

Authentication is a single Cato API Key (`x-api-key` header), with the connection's Cato Account ID
stored as the `cato-account` component hostname and sent both as `x-account-id` and the `accountId`
GraphQL argument - verified directly against `cato-go-sdk`'s `cato.go`/`client.go`.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
deferred to a future pass (Application Control/TLS Inspection/Anti-Malware section lifecycle, Site
LAN network ranges + DHCP, static hosts, the other ~10 structurally-identical staged policy areas,
custom categories - no write API exists for them).
