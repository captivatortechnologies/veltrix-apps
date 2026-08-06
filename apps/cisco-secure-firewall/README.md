# Cisco Secure Firewall (FMC)

Manage [Cisco Secure Firewall Management Center](https://www.cisco.com/site/us/en/products/security/secure-firewall-management-center/index.html)
(FMC, formerly Firepower Management Center) configuration as code through the **FMC REST API**. Author
configurations in the platform's Configuration Canvas and deploy them through the Security-as-Code
pipeline - validate, deploy, health check, drift detection and rollback are handled per configuration
type.

Every route and JSON shape this app uses was verified directly against
[`CiscoDevNet/terraform-provider-fmc`](https://github.com/CiscoDevNet/terraform-provider-fmc) - a
Cisco-maintained Terraform provider whose `gen/definitions/*.yaml` files are 1:1 declarations of each
REST endpoint and its request/response shape - and its `netascode/go-fmc` HTTP client dependency, not
assumed from documentation prose. See **Coverage** below for citations per configuration type.

## Authentication

The app authenticates as a **local or RBAC FMC user** using the same login flow the FMC web UI's login
form uses:

`POST /api/fmc_platform/v1/auth/generatetoken` with HTTP Basic auth (verified against `go-fmc`'s
`client.go` `login()`) returns **HTTP 204 with no body** - the session data arrives entirely in response
headers:

| Header | Contents |
| --- | --- |
| `X-auth-access-token` | The token sent as `X-auth-access-token` on every subsequent request (FMC's own header name - not `Authorization: Bearer`) |
| `X-auth-refresh-token` | A refresh token (`POST /api/fmc_platform/v1/auth/refreshtoken`) - this app re-logs-in on a 401 instead of using it, the same pragmatic session-renewal pattern `apps/teleport/lib/teleport.ts` uses |
| `DOMAIN_UUID` | The connecting user's own login domain UUID |
| `DOMAINS` | A JSON array of every domain the user can see: `[{"name":"Global","uuid":"..."}, ...]` |

1. Create a dedicated FMC user (e.g. `veltrix-automation`) with an **Access Admin** or **Network Admin**
   role scoped to what this app manages.
2. Store its credentials as a Veltrix credential:

| Veltrix credential field | FMC value |
| --- | --- |
| Username | The FMC username |
| Password | That user's password |

3. Register an **`fmc`** component whose hostname is your FMC **management address** (e.g.
   `fmc.example.com`), and attach the credential.

### Domain scoping

Every `/fmc_config/v1/domain/{DOMAIN_UUID}/...` path needs a domain UUID. This app resolves it from the
**Domain Name** app setting (matched case-insensitively against the login's `DOMAINS` list) when set;
otherwise it falls back to the connecting user's own login domain (the `DOMAIN_UUID` header) - correct
for the overwhelmingly common single/Global-domain deployment.

## What it manages

Objects in FMC are identified by a **server-assigned UUID**, not by name (unlike Panorama's name-keyed
REST API) - every config type here upserts by listing the collection, matching by case-insensitive name,
then `PUT .../{id}` (update) or `POST .../` (create). This is `lib/fmc.ts`'s `upsertByName`, the FMC
analogue of `apps/palo-alto-panorama/lib/panorama.ts`'s `upsertObjects`.

| Configuration type | FMC endpoint | Notes |
| --- | --- | --- |
| Security Zones | `/object/securityzones` | `interfaceMode` is immutable once set - FMC rejects changing it on an existing zone |
| Network Objects | `/object/hosts`, `/object/networks`, `/object/ranges`, `/object/fqdns` | One config type, four endpoints - a `Kind` field routes each item to the right one, the same "one canvas type, several REST resources" pattern `apps/palo-alto-panorama`'s Address Objects uses (there, one endpoint with a type field; here, genuinely separate endpoints) |
| Network Groups | `/object/networkgroups` | Members are named references to Host/Network/Range/FQDN/Network Group objects, resolved to `{id, type}` at deploy/drift time |
| Port Objects | `/object/protocolportobjects` | `protocol` accepts a common name (TCP/UDP/ICMP/...) or a numeric IANA protocol number |
| Port Groups | `/object/portobjectgroups` | Members reference existing Port objects by name |
| URL Objects | `/object/urls` | Confirmed a full CRUD resource via `NewURLResource`/`NewURLsResource` registration in the provider's `provider.go` |
| URL Groups | `/object/urlgroups` | Members are a mix of named URL-object references AND literal URL strings - both are unambiguous, distinct arrays in FMC's schema |
| Access Control Policies | `/policy/accesspolicies` | The policy **container** only - name, default action and default-action logging. Note the real path segment is `accesspolicies`, not `accesscontrolpolicies` |
| Access Rules | `/policy/accesspolicies/{policyId}/accessrules` | One rule inside one policy (referenced by name, resolved to its UUID); zones/networks/ports are named references to objects the types above create |

Every managed type follows the same model: validate -> deploy (idempotent upsert by name, tracked for
rollback) -> rollback (delete only what was created) -> health check (declared objects present) -> drift
detect (live vs. declared) -> status.

### Deploy ordering

Later types reference objects the earlier ones create - deploy in this order:

1. Security Zones, Network Objects, Port Objects, URL Objects
2. Network Groups, Port Groups, URL Groups
3. Access Control Policies
4. Access Rules

## Deploy-to-devices is NOT a configuration type

Writing to `/object/*` or `/policy/*` only edits **FMC's own configuration database**. Pushing that
configuration onto the managed firewalls (FTDs) is a separate, **one-shot activation action** -
`POST /deployment/deploymentrequests` - the FMC analogue of a Panorama commit-and-push or a Zscaler
activation. Verified against `gen/definitions/device_deploy.yaml`: the resource is explicitly
`no_data_source`/`no_import`/`no_update`/`no_delete` - **create-only**, with no stable "current state" to
declare or drift-check. Exactly like this catalog's precedent (`apps/palo-alto-panorama`'s `auto_commit`
model), it is **never modeled as a configuration type** here.

Instead, it is an **opt-in side effect** of every successful deploy/rollback, gated by the
`auto_deploy_to_devices` setting (default off):

1. `GET /deployment/deployabledevices` finds devices with pending changes.
2. `POST /deployment/deploymentrequests` with `{type: "DeploymentRequest", deviceList: [...], ignoreWarning}`
   triggers the deployment.

**Flag:** the pairing of `deployabledevices` (discovery) with `deploymentrequests` (trigger) is Cisco's
documented FMC REST API workflow for "deploy everything that's pending," but `deployabledevices` was
**not** independently re-verified against `terraform-provider-fmc` source - that provider's own
`fmc_device_deploy` resource always requires an explicit, caller-supplied `device_id_list` rather than
auto-discovering one (it targets one Terraform-managed apply, not a "deploy everything pending"
sweep). This is flagged here rather than left silent; if `deployabledevices` proves incorrect against a
live FMC, `auto_deploy_to_devices` degrades to reporting "could not list deployable devices" rather than
silently doing nothing.

## Coverage

Audited 2026-08 against `CiscoDevNet/terraform-provider-fmc`'s `gen/definitions/*.yaml` (the REST
endpoint + JSON shape for every FMC resource that provider manages) and its `internal/provider/*.go`
resource registrations. Nine configuration types, chosen for the clearest, most valuable **declarative,
round-trippable** surface - quality over count.

### Considered and dropped (honest gaps)

| Candidate | Why it's not in this release |
| --- | --- |
| **Deploy-to-devices as a configuration type** | One-shot activation action (`POST /deployment/deploymentrequests`, confirmed create-only by `device_deploy.yaml`), not declarative round-trippable state - see "Deploy-to-devices is NOT a configuration type" above |
| **NAT Policies & NAT Rules** (`/policy/ftdnatpolicies`, `.../manualnatrules`, `.../autonatrules`) | `gen/definitions/ftd_manual_nat_rule.yaml` is explicitly annotated `"Manual resource - Resource (Create), adjustBody"` - even this Cisco-maintained provider does not implement safe update/delete round-tripping for NAT rules. Modeling a rule type this app cannot safely reconcile would not meet the same declarative bar as everything else here |
| **Prefilter Policies** (`/policy/prefilterpolicies`) | A genuine full-CRUD resource, but its rules (tunnel/prefilter rules matched by interface, not zone) are a distinct schema this release did not have room to model with the same care as Access Rules - a good candidate for a future release |
| **Intrusion Policies** (`/policy/intrusionpolicies`) | Per the task's own framing, largely a Cisco Talos-managed rule surface (base policy + rule overrides + variable sets), not a small, clean declarative object - deferred rather than modeled shallowly |
| **File Policies** (`/policy/filepolicies`) | A genuine resource, but its rules reference file-type sets and Advanced Malware Protection cloud-lookup actions - a distinct, nontrivial schema deferred to keep this release's nine types uniformly well-modeled |
| **Syslog Alerts** (`/policy/syslogalerts`) | Confirmed **read-only** - `gen/definitions/syslog_alert.yaml` is explicitly annotated `no_resource: true`. There is no create/update/delete route for this object in the surface this app was verified against |
| **VLAN Tag Groups** (`/object/vlangrouptags`) | A genuine full-CRUD resource, straightforward but niche (VLAN tag ranges are mostly consumed by NAT and Prefilter rules, both out of scope this release) - a small future addition, not excluded for a technical reason |
| **ICMPv4/ICMPv6 objects** | Port Group members may reference these (`port_group.yaml`'s `enum_values: [ProtocolPortObject, ICMPV6Object, ICMPV4Object]`), but this app only manages plain protocol/port objects - a Port Group member name that resolves only to an ICMP object will not resolve here (see Port Groups' canvas notes) |
| **Access Rules' literal (inline) network/port/URL match values** | FMC's schema wraps BOTH literal and object-reference match values under the same field (e.g. `sourceNetworks: {objects: [...], literals: [...]}`), but the only ground truth this app was built against (`access_rule.yaml`) marks every literal entry's `type` attribute `value: AnyNonEmptyString` - a generator placeholder, not the real wire value FMC expects (real FMC literals are typed, e.g. `"Host"` vs `"Network"`). Rather than guess at that shape, Access Rules, Network Groups and Port Groups in this app are **reference-only**: match conditions and group members always point at an object this app itself creates. Port literals (`{"type":"PortLiteral","protocol":"6","port":"80"}`) and URL Group literals (`{"url":"..."}`) ARE unambiguous in the ground truth and so URL Groups do support literal members - see the table above |
| **Access Rules' users/SGT/applications/file-policy/intrusion-policy/variable-set/time-range conditions** | Advanced/niche match criteria present in `access_rule.yaml` but out of scope for this release's rule model - the same "common case first" scoping precedent `apps/palo-alto-panorama`'s Security Rules applies to its own rule type |
| **Access Rules' `category` placement** (vs. `section`) | `access_rule.yaml`: "Either 'section' or 'category_name' can be set." This app models `section` (default/mandatory) only - category placement requires a pre-existing category object this app does not manage |
| **Rule ordering within a policy** | Not managed; rules are upserted by name, not by position. FMC's own bulk `fmc_access_rules` resource (early access, per its own definition file) recreates the *entire* rule set on any change specifically to preserve ordering - this app's per-rule upsert model does not attempt that |

### Known limitations (honest, not stubs)

- **Access Rule `description` cannot be drift-checked.** `access_rule.yaml` marks it `write_only: true #
  absent in GET` - FMC never returns it on read, so redeploy is the only way to confirm or correct it.
- **A name that exists as both, say, a Host and a Network object is ambiguous.** Network Objects'
  `Kind` field routes each ITEM to its own endpoint, so this only affects **references** (Network Groups'
  members, Access Rules' network conditions): `lib/fmcRefs.ts`'s merged index keeps whichever type was
  indexed last (Network Groups win) when two objects share a name across types - avoid duplicate names
  across Host/Network/Range/FQDN/Network Group objects.
- **`deployabledevices` is a documented-but-not-independently-reverified endpoint** - see the
  Deploy-to-devices section above.
- **Rollback never restores objects it updated in place**, only deletes objects it created - the same
  non-destructive model `apps/palo-alto-panorama`'s pipeline uses. Prefer letting this app own the
  objects it manages.

## Health check

Each configuration type's health check confirms FMC is reachable and the credential is valid (a list
call against that type's own endpoint), then confirms every item declared in the canvas is still present.
Access Rules additionally resolves each rule's owning Access Control Policy before checking rule
presence within it.

## Development

```
cd apps/cisco-secure-firewall
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs cisco-secure-firewall  # run tests
node ../../scripts/validate-app.mjs apps/cisco-secure-firewall  # validate
```

## References

- Cisco Secure Firewall / FMC REST API: <https://developer.cisco.com/docs/firepower/>
- Ground truth this app was verified against:
  [`CiscoDevNet/terraform-provider-fmc`](https://github.com/CiscoDevNet/terraform-provider-fmc)
  (`gen/definitions/*.yaml` for every endpoint/shape cited above,
  `internal/provider/provider.go` for resource registration) and its
  [`netascode/go-fmc`](https://github.com/netascode/go-fmc) HTTP client dependency (`client.go` for the
  auth flow, `res.go` for the pagination/response shape).
