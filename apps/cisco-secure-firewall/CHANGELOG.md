# Changelog

All notable changes to the Cisco Secure Firewall (FMC) app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Cisco Secure Firewall Management Center (FMC, formerly Firepower Management
Center) config-as-code app, built research-first directly against
[`CiscoDevNet/terraform-provider-fmc`](https://github.com/CiscoDevNet/terraform-provider-fmc)'s
`gen/definitions/*.yaml` endpoint declarations and its `netascode/go-fmc` HTTP client dependency, not
documentation assumptions.

Nine configuration types, covering FMC's clearest declarative, round-trippable object and policy surface
reachable through the **FMC REST API**:

- **Security Zones** (`config-types/security-zones`) — `/object/securityzones`.
- **Network Objects** (`config-types/network-objects`) — Host/Network/Range/FQDN via
  `/object/hosts|networks|ranges|fqdns`, selected by a `Kind` field.
- **Network Groups** (`config-types/network-groups`) — `/object/networkgroups`, members reference
  existing network objects by name.
- **Port Objects** (`config-types/port-objects`) — `/object/protocolportobjects`.
- **Port Groups** (`config-types/port-groups`) — `/object/portobjectgroups`, members reference existing
  Port objects by name.
- **URL Objects** (`config-types/url-objects`) — `/object/urls`.
- **URL Groups** (`config-types/url-groups`) — `/object/urlgroups`, members are named URL-object
  references and/or literal URLs.
- **Access Control Policies** (`config-types/access-control-policies`) — the policy container
  (name/default action) via `/policy/accesspolicies`. Note: the real path is `accesspolicies`, not
  `accesscontrolpolicies`.
- **Access Rules** (`config-types/access-rules`) — rules inside a policy via
  `/policy/accesspolicies/{id}/accessrules`, referencing zones/networks/ports by name.

Authentication is an FMC user's username/password via `POST /api/fmc_platform/v1/auth/generatetoken`
(the FMC web UI's own login call, HTTP Basic auth, session data returned in response headers per the
verified `go-fmc` client). Domain scoping resolves from an optional `domain_name` setting or the
connecting user's own login domain.

**Deploy-to-devices is deliberately NOT a configuration type** — pushing FMC's configuration database
onto managed firewalls is a one-shot activation action (`POST /deployment/deploymentrequests`, confirmed
create-only), the same treatment this catalog's `apps/palo-alto-panorama` gives Panorama's commit. It is
instead an opt-in side effect of deploy/rollback, gated by the `auto_deploy_to_devices` setting.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus deferred
(NAT policies/rules, Prefilter Policies, Intrusion Policies, File Policies, Syslog Alerts, VLAN Tag
Groups, and why) and the honest limitations around reference resolution and literal match values.
