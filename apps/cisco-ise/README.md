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
[EndPointGroup — ERS API v1](https://developer.cisco.com/docs/identity-services-engine/latest/endpointgroup/).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Endpoint Identity Groups** | ISE ERS API (`/ers/config/endpointgroup`, `/ers/config/endpointgroup/{id}`) | ✅ v0.1.0 |

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

## Notes

The ERS envelope conventions used here — the `SearchResult` list wrapper
(`{ SearchResult: { total, resources: [...] } }`), the single-resource wrapper
(`{ EndPointGroup: {...} }`), the `Location` response header carrying a newly
created resource's id, and the `ERSResponse.messages` error shape — are
consistent across every ERS resource type, not just endpoint groups. The
endpoint-group-specific field set (`id`, `name`, `description`,
`systemDefined`) was verified against the DevNet EndPointGroup reference and
Cisco's own ERS examples. **Verify against a live ISE node** before treating an
edge case (e.g. the exact `ERSResponse` failure shape on a duplicate name) as
final.

TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting. There is no separate `ers_port` setting — ERS is fixed to
9060; if yours is proxied to a different port, include it in the connection's
endpoint (e.g. `ise-pan.example.com:9443`).

Apache-2.0.
