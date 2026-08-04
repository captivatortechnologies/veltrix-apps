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
[pyise-ers](https://github.com/falkowich/pyise-ers) (community ERS client, exercised against real ISE — verified `networkdevicegroup`, `networkdevice`, `internaluser`, `endpoint`, `sgt` and `sgacl` field shapes and the irregular `ERSEndPoint` wrapper key),
[CiscoISE/ansible-ise](https://github.com/CiscoISE/ansible-ise) (official Cisco Ansible collection, generated from Cisco's own ERS/OpenAPI definitions — verified `authorizationprofile`, `downloadable_acl`, `allowed_protocols`, `identitygroup` and `sgt` field shapes and wrapper keys).

## Configuration types

| Type | Sidebar group | Surface | Status |
|---|---|---|---|
| **Endpoint Identity Groups** | Identity Management | `/ers/config/endpointgroup` | ✅ v0.1.0 |
| **Network Device Groups** | Network Devices | `/ers/config/networkdevicegroup` | ✅ v0.2.0 |
| **Network Devices** | Network Devices | `/ers/config/networkdevice` | ✅ v0.2.0 |
| **Authorization Profiles** | Policy Elements | `/ers/config/authorizationprofile` | ✅ v0.2.0 |
| **Downloadable ACLs** | Policy Elements | `/ers/config/downloadableacl` | ✅ v0.3.0 |
| **Allowed Protocols** | Policy Elements | `/ers/config/allowedprotocols` | ✅ v0.3.0 |
| **Security Group Tags** | TrustSec | `/ers/config/sgt` | ✅ v0.3.0 |
| **Security Group ACLs** | TrustSec | `/ers/config/sgacl` | ✅ v0.3.0 |
| **Internal Users** | Identity Management | `/ers/config/internaluser` | ✅ v0.3.0 |
| **User Identity Groups** | Identity Management | `/ers/config/identitygroup` | ✅ v0.3.0 |
| **Endpoints** | Identity Management | `/ers/config/endpoint` | ✅ v0.3.0 |

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

### Downloadable ACLs (v0.3.0)

Named ACL content (`dacl`, one or more lines) plus an IP-version tag, applied
over `/ers/config/downloadableacl` (SDK class / wrapper key `Downloadableacl`,
confirmed directly from the official Ansible module's own metadata). Referenced
by name from an Authorization Profile's `daclName` field.

### Allowed Protocols (v0.3.0)

Manages an Allowed Protocols service's **top-level** authentication-method
enable flags (PAP/CHAP/MS-CHAPv1/v2, EAP-MD5/TLS/TTLS/FAST/TEAP, LEAP),
`preferredEapProtocol` and `processHostLookup`, over
`/ers/config/allowedprotocols` (wrapper key `Allowedprotocols`, confirmed from
the Ansible module doc text). **Dropped / out of scope**: the real schema also
nests `eapFast` / `eapTls` / `eapTtls` / `peap` / `teap` sub-objects (a dozen+
fields each) — a full implementation of those was out of scope for this wave;
an update from this app never touches them (ERS merges the top-level fields
sent here with whatever nested configuration already exists live).
`preferredEapProtocol` is a free-text field rather than a fixed dropdown — only
one example value (`PEAP`) could be confirmed; ISE's exact accepted values and
casing for the others were not fully enumerable from available sources.

### Security Group Tags & ACLs (TrustSec, v0.3.0)

TrustSec **SGTs** (`/ers/config/sgt`, wrapper `Sgt`) and **SGACLs**
(`/ers/config/sgacl`, wrapper `Sgacl`) — cross-validated against BOTH
`pyise-ers` (a working, community-exercised client) and the official Ansible
collection's `sgt.py` module (whose own SDK metadata literally names the class
`Sgt`). SGT's `value` is the numeric tag (2-65519, or `-1` to auto-generate —
an UPDATE preserves the tag's existing value rather than resending `-1`, which
would otherwise ask ISE to reassign an already-live tag on every redeploy).
`propogateToApic` keeps Cisco's own wire-field typo (their schema, not this
app's) — the canvas labels it correctly ("Propagate to APIC"). Built-in
read-only SGTs (`isReadOnly: true`, e.g. `Unknown`) are never targeted by this
app's own writes, but naming a canvas item the same as one will surface ISE's
own rejection at deploy time rather than being pre-emptively blocked here.
SGACL content (`aclcontent`) is sent as ONE newline-joined string, not an
array. **Dropped**: the TrustSec egress **matrix** (source SGT × destination
SGT → SGACL(s) cell assignments) — see Coverage below.

### Internal Users (v0.3.0)

Local ISE users (`/ers/config/internaluser`, wrapper `InternalUser`, verified
against `pyise-ers`'s `add_user`). Manages username, name/email, description,
and an optional list of identity-group **names** — resolved to ERS's actual
wire format (a single comma-separated string of group **ids**, not names, not
a JSON array) via a live lookup on the User Identity Groups resource before
every deploy.

⚠ **Both `password` and `enablePassword` (the separate TACACS+ "enable"
secret) are write-only.** ISE never returns either on a GET, so this app can
never read, diff, or capture them: each is sent only when its canvas field is
non-blank, both are stripped from every rollback snapshot before it is
persisted, and neither is ever compared during drift detection. A user whose
password was rotated by a deploy **cannot** have the prior password restored
by rollback — only the non-secret fields are restored.

### User Identity Groups (v0.3.0)

Unlike Network Device Groups' "#"-path convention, (user) Identity Groups
(`/ers/config/identitygroup`) are a genuine parent/child **tree** — verified
against the official Ansible collection's `identitygroup.py` module doc, which
confirms `name` / `description` / `parent` and that create (POST, no
pre-existing id) is supported. `parent` is authored as another group's NAME
and resolved to its id via a live lookup on this same resource (an earlier
item in the same configuration can be a later item's parent, since deploy
applies items in canvas order). **UNVERIFIED**: the single-resource wrapper key
`IdentityGroup` — every other `*Group` ERS resource this app manages
(`EndPointGroup`, `NetworkDeviceGroup`) uses full intercapped PascalCase, so
the same pattern was applied here, but — unlike every other wrapper key in
this app, all directly confirmed from a real request/response example — this
one could not be. Verify against a live ISE node.

### Endpoints (v0.3.0)

Individual endpoint MAC-address records (`/ers/config/endpoint`) — distinct
from the Endpoint Identity **Groups** config type, which manages the groups
themselves. Identity is the MAC address (ISE's own filter field, `mac.EQ.`,
not `name.EQ.`) — `lib/iseApi.ts`'s generic client gained an
`identityFilterField` option for exactly this case. The single-resource
wrapper key is the irregular **`ERSEndPoint`** (not `Endpoint`) — confirmed
identically by BOTH `pyise-ers`'s `add_endpoint` and an independently-published
Cisco curl example. An optional endpoint identity group **name** is resolved
to its id via a live lookup on the SAME `EndPointGroup` resource the
endpoint-identity-groups config type manages. **Dropped / out of scope**:
profiler-policy assignment (`profileId`/`staticProfileAssignment`), portal-user
linkage (`portalUser`) and custom attributes — all real `ERSEndPoint` fields,
none implemented here (see Coverage below for why profiler assignment
specifically is excluded).

## Coverage

A wave-3 pass enumerated Cisco's declarative config-as-code surface across
BOTH ERS (`/ers/config/...`) and ISE's newer OpenAPI domain (`/api/v1/...`),
against the official ISE ERS/DevNet docs, the community `pyise-ers` client
(exercised against real ISE deployments) and the official `CiscoISE/ansible-ise`
collection (generated from Cisco's own ERS/OpenAPI definitions). Every result
below is **managed** or **excluded with a reason** — nothing is silently
skipped.

**Managed (11 config types, all over ERS):** endpoint identity groups, network
device groups, network devices, authorization profiles, downloadable ACLs,
allowed protocols (top-level flags), TrustSec security group tags, TrustSec
security group ACLs, internal users, user identity groups, and individual
endpoints. See each type's section above for its exact field scope and drops.

**ERS vs. OpenAPI.** Every one of the 11 config types above turned out to have
a stable, well-documented ERS resource — there was no need to add a second
transport. ISE's OpenAPI domain was still evaluated, and is excluded as a
*transport*, not skipped:

- **Network-access policy sets, authentication/authorization rules and their
  condition trees** (`/api/v1/policy/network-access/...`) — this is ISE's core
  policy engine: an ORDERED list of rule sets, each containing ordered
  authentication/authorization rules with nested condition trees (AND/OR
  groups referencing dictionary attributes) and exception rules, where
  **position matters** (a rule earlier in the list can shadow one below it).
  That doesn't fit this app's flat, independent, name-keyed "list of items"
  canvas model — safely authoring it would need an ordering/precedence-aware
  UI and transaction-scoped edits (moving one rule can change what another
  matches), which is a fundamentally different modeling problem than every
  other config type here. Excluded rather than modeled unsafely.
- **TrustSec SGT** also has a newer OpenAPI equivalent
  (`/api/v1/trustsec/sgt`) — this app manages it over ERS instead (see above),
  since ERS already had a directly-verified, working implementation and stays
  on the same auth/transport/envelope conventions as every other config type.
- Everything else under `/api/v1/...` (node deployment, backup/restore,
  patching, AD domain join/leave, CSR/certificate lifecycle, licensing) is
  administrative/operational action, not a declarative resource — see below.

**Intentionally excluded, with why:**

- **Certificates & CSR lifecycle** (system certificates, CA certificates,
  CSR generate/bind, certificate templates/profiles) — key material and
  trust-chain operations are an appliance security-posture concern with severe
  failure modes (an ISE node can lose admin/EAP connectivity from a bad
  certificate swap); this is an intentionally out-of-band operational task, not
  something this app automates.
- **Portals & guest/sponsor workflows** (Guest Portal, Sponsor Portal, Hotspot
  Portal, BYOD Portal, Guest Types, Guest Users, Sponsor Groups, portal
  branding/themes) — a distinct, UI-heavy product surface (self-service flows,
  branding assets, notification templates) orthogonal to this app's
  network-access policy scope.
- **Per-node / deployment operations** (node registration, PAN/PSN/MnT
  role assignment, patch install, backup/restore, licensing, Active Directory
  join/leave, pxGrid) — one-shot imperative actions against a specific
  appliance instance, not a flat declarative resource with a stable identity
  to upsert against.
- **TrustSec egress matrix** (source SGT × destination SGT → SGACL cell
  assignments) — SGTs and SGACLs (both managed above) are the *inputs*; the
  matrix itself is a 2-D, ordering-and-default-sensitive grid, not a
  name-keyed flat list, and a mis-declared cell has network-wide blast radius.
- **Endpoint profiling** (profiler policies/probes, `profileId` /
  `staticProfileAssignment` on an Endpoint) — profiling is ISE's continuous,
  automated device-fingerprinting pipeline; statically pinning a profile via
  config-as-code fights that pipeline rather than complementing it (this is
  why `config-types/endpoints` manages group assignment but not profiling).
- **Session / operational / monitoring / reporting APIs** (active sessions,
  MnT reports, health/performance counters, ANC endpoint-clear) — read-only
  telemetry or transient runtime state, not configuration.

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
