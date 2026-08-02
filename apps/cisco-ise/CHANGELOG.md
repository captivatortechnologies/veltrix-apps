# Changelog

All notable changes to the Cisco ISE app are documented here.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Endpoint Identity Groups** config type — create / edit / delete Cisco ISE
  endpoint identity groups (name, description) over the ISE External RESTful
  Services (ERS) API (`/ers/config/endpointgroup`), with validate / deploy
  (upsert by group name) / rollback (restore prior description or delete
  created) / health-check / drift-detect / status. Only non-system-defined
  groups are ever created or modified — ISE's built-in groups are untouched.
- **Connectivity test** against the ERS API (`GET /ers/config/endpointgroup
  ?size=1`, HTTP Basic, self-signed TLS tolerated) using an ISE administrator
  in the ERS-Admin or ERS-Operator group.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (enable
  ERS → administrator account → credential → connection), and Connections
  (wraps the SDK `ConnectionsManager` for an ISE PAN/admin node; saving a
  connection registers `cisco-ise` as a deploy target).

> ERS must be explicitly enabled per PAN/admin node (Administration > System >
> Settings > API Settings > ERS Settings) — the port (9060, fixed) is closed
> until then, so a request against it times out rather than erroring. The ERS
> envelope conventions (`SearchResult` list wrapper, `EndPointGroup` single-
> resource wrapper, `Location`-header id on create, `ERSResponse.messages`
> error shape) are shared across every ERS resource and were verified against
> the DevNet EndPointGroup reference and Cisco's own ERS examples; **verify
> against a live ISE node** before treating an edge case as final. TLS
> verification is off by default (self-signed) and configurable via the
> `verify_tls` setting. Parent/nested endpoint groups are not exposed by the
> current ERS API and are intentionally out of scope.
