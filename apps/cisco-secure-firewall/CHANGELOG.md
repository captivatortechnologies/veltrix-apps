# Changelog

All notable changes to the Cisco Secure Firewall (FMC) app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.2 — 2026-09-17

### Fixed — drift stops claiming "in sync" from a run that could not look

`driftDetect` returned a bare `{ hasDrift: false, diffs: [] }` when the client
could not be built — no usable credential, no tenant host. That is not "I checked
and it matches": the platform treats `hasDrift: false` as a positive assurance
and resolves the component's outstanding drift record with `drift_cleared`, so a
rotated or revoked credential silently wiped real drift on the next scheduled
run.

Those paths now return `checked: false`, on which the platform records nothing
and clears nothing. An earlier catalog-wide pass fixed the single-line spelling
of this guard; this is the braced form it did not match, and `veltrix validate`
now rejects both.

## 0.1.1 — 2026-09-16

### Fixed — drift no longer claims "in sync" from a run that could not look

`driftDetect` returned `{ hasDrift: false, diffs: [] }` when it had no usable
credential, and again when the vendor refused the read. That is not "I checked
and found nothing" — it is "I never looked". The platform cannot tell the
difference: it treats `hasDrift: false` as a positive assurance and resolves the
component's outstanding drift record with `drift_cleared`.

So a rotated credential, a de-scoped API user or a vendor maintenance window
silently wiped real drift on the next scheduled run, and the console showed a
clean estate.

Those paths now return `checked: false` (`DriftResult.checked`, SDK 3.9.0), on
which the platform records nothing and clears nothing. Where a handler loops
over several objects and skips the ones it could not read, the run reports
`checked: false` too, rather than "in sync" from a partial view. A return that
genuinely established "nothing is deployed, so there is no drift" is unchanged.

`veltrix validate` now rejects the bare form, so it cannot come back.

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
