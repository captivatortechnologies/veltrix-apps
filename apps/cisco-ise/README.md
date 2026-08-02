# 🪪 Cisco ISE

Manage [Cisco Identity Services Engine (ISE)](https://developer.cisco.com/identity-services-engine/)
— network access control (NAC) — as code on the Veltrix Security-as-Code
platform. Author configuration in the Configuration Canvas and drive it
through the pipeline (validate → deploy → rollback → health-check →
drift-detect → status).

## How it's managed

ISE exposes a separate management plane from its admin GUI — the **External
RESTful Services (ERS)** API — that this app applies configuration over:

- **Fixed port, opt-in** — ERS listens on its own HTTPS port, **9060**, which is
  **closed by default**. An administrator must enable it per PAN/admin node
  under **Administration > System > Settings > API Settings > ERS Settings**
  before this app (or anything else) can reach it — a request against a
  disabled ERS simply times out rather than returning an HTTP error.
- **HTTP Basic auth, every request** — no token exchange, no session. The
  credential is an ISE administrator in the **ERS-Admin** (read/write) or
  **ERS-Operator** (read-only) group.
- **JSON** — ERS supports both XML and JSON; this app always sends and
  requests JSON (`Accept` / `Content-Type: application/json`).
- **Self-signed TLS tolerated** — ISE ships a self-signed certificate on the
  ERS port until an administrator installs a CA-signed one; the transport
  accepts the default self-signed cert unless the `verify_tls` setting is
  turned on.

References:
[Cisco ISE APIs — DevNet](https://developer.cisco.com/identity-services-engine/),
[EndPointGroup — ERS API v1](https://developer.cisco.com/docs/identity-services-engine/latest/endpointgroup/),
[pyise-ers](https://github.com/falkowich/pyise-ers) (community ERS client, exercised against real ISE — verified `networkdevicegroup` / `networkdevice` field shapes),
[CiscoISE/ansible-ise](https://github.com/CiscoISE/ansible-ise) (official Cisco Ansible collection, generated from Cisco's own ERS/OpenAPI definitions — verified `authorizationprofile` field shape).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Endpoint Identity Groups** | ISE ERS API (`/ers/config/endpointgroup`, `/ers/config/endpointgroup/{id}`) | ✅ v0.1.0 |
| **Network Device Groups** | ISE ERS API (`/ers/config/networkdevicegroup`, `/ers/config/networkdevicegroup/{id}`) | ✅ v0.2.0 |
| **Network Devices** | ISE ERS API (`/ers/config/networkdevice`, `/ers/config/networkdevice/{id}`) | ✅ v0.2.0 |
| **Authorization Profiles** | ISE ERS API (`/ers/config/authorizationprofile`, `/ers/config/authorizationprofile/{id}`) | ✅ v0.2.0 |

An endpoint identity group is ISE's mechanism for classifying endpoints
(profiled devices, manually-assigned groups) for use in authorization policy
conditions. The group **name** is the stable identity used to upsert (create
vs. update) and to detect drift. Deploy snapshots the prior full resource so
rollback can restore it — or delete a group it created.

Every group this app creates or updates is sent with `systemDefined: false`.
ISE's **built-in** groups (`Unknown`, `Profiled`, `Cisco-IP-Phone`,
`Blacklist`, ...) are **never** created or modified — this app only manages
custom groups, matched by name against ISE's non-system-defined set.

**Not yet supported** (flagged rather than faked): ERS's `EndPointGroup`
resource has no `parent` group field as of the current ERS API version, so
nested/parent groups are out of scope — verify against your ISE release before
assuming this changed.

### Network Device Groups (v0.2.0)

Network Device Groups (NDGs) are ISE's hierarchy for classifying network
devices (by Location, Device Type, or a custom root category). The ERS
`name` field is the **full "#"-separated path** from the root (e.g.
`Location#All Locations#SanJose`), and the root category field — `othername`
— is **always derived** from `name`'s first `#` segment, never authored
separately (mirrors the community `pyise-ers` client's own approach).

> **Correction vs. the original spec.** This config type was scoped against a
> field named `ndgtype`. Verifying against `pyise-ers`'s actual working
> `add_device_group`/`update_device_group` calls (exercised against real ISE
> deployments) showed the real ERS field is **`othername`** — implemented with
> the verified name; `ndgtype` does not appear anywhere in the ERS schema.

### Network Devices (v0.2.0)

A network device is a NAS/AAA client (switch, WLC, VPN concentrator, ...) ISE
authenticates. Manages the device name, one or more **IPv4** addresses (with
mask), Network Device Group membership (defaulted to the `Location`/`Device
Type` root groups ISE itself requires), and an optional RADIUS shared secret.

⚠ **The RADIUS shared secret is write-only.** ISE never returns it on a GET, so
this app can never read, diff, or capture it — it is sent to ISE only when the
canvas field is non-blank, is stripped from every rollback snapshot before it
is persisted, and is never compared during drift detection. Leaving the field
blank on an existing device does **not** clear its current secret. A device
whose secret was rotated by a deploy **cannot** have the prior secret restored
by rollback — only the non-secret fields (name, description, IPs, NDG
membership) are restored; reset the secret manually in ISE if the old value
must be recovered.

**Dropped / out of scope**: IPv6 addresses, TACACS+ settings, SNMP settings,
device profile / CoA port customization — not implemented (defaults matching
ISE's own admin-UI defaults were verified in `pyise-ers`'s `add_device` but
this app does not expose overriding them).

### Authorization Profiles (v0.2.0)

Manages **standard ("SWITCH")** authorization profiles: access type
(Access-Accept/Access-Reject), VLAN assignment (`vlan.nameID` + the RFC 2868
RADIUS tunnel tag `vlan.tagID`, 0-31), a Downloadable ACL (`daclName`), a
Filter-Id ACL (`acl`, independent of the DACL), an Airespace/WLC ACL
(`airespaceACL`), and free-form advanced RADIUS/vendor attributes
(`advancedAttributes`, authored as JSON — see the canvas field's help text).

**Dropped / out of scope** (flagged, not faked): TrustSec and TACACS+ profile
types (`authzProfileType` is always sent as `SWITCH`), `ipv6DaclName` /
`ipv6ACLFilter` / `airespaceIPv6ACL`, `macSecPolicy`, `webRedirection` (portal
profiles), `reauth` (periodic re-authentication), and the vendor-specific
`asaVpn` / `avcProfile` / `interfaceTemplate` / `serviceTemplate` /
`autoSmartPort` / `uniqueIdentifier` fields — all present in ISE's fuller
schema per the official Ansible collection docs, none implemented here.

## Notes

The ERS envelope conventions used here — the `SearchResult` list wrapper
(`{ SearchResult: { total, resources: [...] } }`), the single-resource wrapper
(e.g. `{ EndPointGroup: {...} }`, `{ NetworkDevice: {...} }`), the `Location`
response header carrying a newly created resource's id, and the
`ERSResponse.messages` error shape — are consistent across every ERS resource
type. `lib/iseApi.ts`'s `buildErsResourceClient` implements this ONE transport
generically; every config type supplies only its own URL segment, wrapper key
and field set. **Verify against a live ISE node** before treating an edge case
(e.g. the exact `ERSResponse` failure shape on a duplicate name) as final.

TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting. There is no separate `ers_port` setting — ERS is fixed to
9060; if yours is proxied to a different port, include it in the connection's
endpoint (e.g. `ise-pan.example.com:9443`).

Apache-2.0.
