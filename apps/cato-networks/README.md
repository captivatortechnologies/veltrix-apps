# Cato Networks

Manage [Cato Networks](https://www.catonetworks.com/) (SASE/SSE) configuration as code through the
**Cato Management Application (CMA) GraphQL API**. Author configurations in the platform's
Configuration Canvas and deploy them through the Security-as-Code pipeline - validate, deploy,
health check, drift detection and rollback are handled per configuration type.

## Credentials

The app authenticates with a **Cato API Key**:

1. In the Cato Management Application, go to **Administration > API Keys** and click **+ New**.
2. Scope the key's role to what this app manages (Internet/WAN Firewall, Application Control, TLS
   Inspection, Anti-Malware, Custom Applications, Network Ranges).
3. Copy the generated API key - it is shown once.

Store it as a Veltrix credential:

| Veltrix credential field | Cato value |
| --- | --- |
| API token | The Cato API Key |

Register a **`cato-account`** component whose hostname is your **Cato Account ID** (Cato Management
Application, top-right account switcher, or Administration > API Keys), and attach the credential.

On every request the app sends the API key as `x-api-key`, the account id as `x-account-id`, AND as
the `accountId` GraphQL argument on the query/mutation root field being called (`policy(accountId)`,
`object(accountId)`, `customAppData(accountId)`) - the exact header/argument pairing was verified
directly against Cato's own generated Go SDK
([`catonetworks/cato-go-sdk`](https://github.com/catonetworks/cato-go-sdk), `cato.go` /
`client.go`), which is generated from the same GraphQL schema
(`cato_api.graphqls`) that backs <https://api.catonetworks.com/documentation/>.

## The staged config model (publish / revert)

Cato's CMA works like most enterprise firewall managers: every write to a policy area
(Internet Firewall, WAN Firewall, Application Control, TLS Inspection, Anti-Malware File Hash) lands
in the calling admin's own **private draft revision** first - nothing is live until
`publishPolicyRevision` is called. This is Cato's equivalent of Zscaler ZIA's `activate()` or
Panorama's `commit()`, and this app handles it the same way those apps do - **not** as its own
configuration type:

- **Deploy** performs every `addRule` / `updateRule` / `removeRule` / `moveRule` (and the section
  equivalents), then calls `publishPolicyRevision` **once** at the end. If publish fails, the writes
  remain staged (not live) and `rollbackData` is returned so the platform can revert; re-running
  deploy retries publish.
- **Rollback** does not need to "discard" a draft (which would also blow away any other admin's
  concurrent in-progress edits) - it replays the **previous canvas version's own declared spec**
  for every rule/section this deploy touched (create → delete; update → restore), then publishes
  that reversal. This mirrors how `wiz-integrations` handles the same "the target's read shape
  doesn't match its write shape" problem in this codebase, and avoids ever needing a live
  read-then-convert round trip through Cato's ref objects.
- A documented, real race - `reorderPolicyBlockedByActiveSessions` / "Cannot reorder policy while
  other active revisions exist" - is retried with backoff, mirroring
  `terraform-provider-cato`'s own `withPolicyRevisionConflictRetry`.
- If a publish has nothing staged, Cato returns `status: FAILURE` with `errorCode:
  PolicyRevisionNotFound` - the official Terraform provider treats that specific code as a no-op,
  not an error, and so does this app (see `policy_publish_application_control.go`).

**Custom Applications** and **Network Ranges** (Global IP Range objects) are NOT part of this staged
workflow - `CustomAppDataMutations` and `ObjectMutations` expose no publish/discard mutation in the
schema, so those two config types apply immediately.

## What it manages

| Configuration type | Cato object(s) | API |
| --- | --- | --- |
| Internet Firewall Sections | Rule groups + order | `policy(accountId).internetFirewall` - `addSection`/`updateSection`/`removeSection`/`moveSection` |
| Internet Firewall Rules | Outbound internet-bound traffic rules | `policy(accountId).internetFirewall` - `addRule`/`updateRule`/`removeRule`/`moveRule` |
| WAN Firewall Sections | Rule groups + order | `policy(accountId).wanFirewall` - `addSection`/`updateSection`/`removeSection`/`moveSection` |
| WAN Firewall Rules | Site-to-site/datacenter traffic rules | `policy(accountId).wanFirewall` - `addRule`/`updateRule`/`removeRule`/`moveRule` |
| Application Control Rules | CASB application/data/file rules | `policy(accountId).applicationControl` - `addRule`/`updateRule`/`removeRule`/`moveRule` |
| TLS Inspection Rules | Which traffic gets decrypted | `policy(accountId).tlsInspect` - `addRule`/`updateRule`/`removeRule`/`moveRule` |
| Anti-Malware File Hash Rules | Per-file block/bypass exceptions (SHA-256) | `policy(accountId).antiMalwareFileHash` - `addRule`/`updateRule`/`removeRule`/`moveRule` |
| Custom Applications | Reusable destination+port/protocol objects | `customAppData(accountId)` - `addCustomApplication`/`updateCustomApplication`/`deleteCustomApplication` |
| Network Ranges | Account-wide reusable Global IP Range objects | `object(accountId)` - `createGlobalIpRangeBulk`/`updateGlobalIpRangeBulk`/`deleteGlobalIpRangeBulk` |

All rule/object identity is the **name** - the CMA API has no upsert, so deploy always lists the live
objects, matches by name, and calls the create or update mutation accordingly.

### Matching criteria as JSON

Every rule's deep matching criteria (source/destination/application/service/exceptions/tracking/
schedule/country/device/...) varies enormously in shape between policy areas and is expressed as
recursive GraphQL input objects. Rather than trying to decompose every possible field into canvas
controls (and inevitably falling behind Cato's own schema), these fields live in a single JSON
escape-hatch field, `rule_json` (or `criteria_json` for Custom Applications) - the exact same
convention `zscaler`'s firewall rule types use for the same reason. Cato's generic
`{"by":"NAME","input":"<name>"}` / `{"by":"ID","input":"<id>"}` reference objects are written
verbatim (sites/hosts/groups/users/categories/custom apps/countries/...). Every field's exact wire
shape (with an example) is documented in that field's help text in `canvas.yaml`.

### Ordering (position)

Both rules and sections carry a `position` field (`FIRST_IN_SECTION` / `LAST_IN_SECTION` /
`BEFORE_RULE` / `AFTER_RULE` for rules; `LAST_IN_POLICY` / `BEFORE_SECTION` / `AFTER_SECTION` for
sections) that maps directly onto Cato's own `PolicyRulePositionInput` / `PolicySectionPositionInput`
- resolved to the referenced sibling's live id at deploy time. Position is re-asserted on every
deploy (via `moveRule`/`moveSection`), so reordering items in the canvas converges the live policy,
not just their first creation.

## Coverage

This first release targets the **9 highest-value, genuinely declarative and round-trippable**
surfaces of the CMA API - the core network-security policy a SASE/network-security team would author
as code: the two flagship firewall policies (Internet + WAN) with full section AND rule lifecycle,
the CASB-style Application Control and TLS Inspection rule sets, the one genuinely writable slice of
the anti-malware/threat-prevention surface, and the two most broadly-referenced network objects
(Custom Applications, Global IP Range).

### Intentionally excluded (this release)

| Surface | API | Why excluded |
| --- | --- | --- |
| Application Control / TLS Inspection / Anti-Malware SECTION lifecycle | `policy(accountId).applicationControl\|tlsInspect\|antiMalwareFileHash` - `addSection`/`updateSection`/`removeSection`/`moveSection` | Structurally identical to Internet/WAN Firewall's section mutations, but three more section-CRUD config types would triple this release's type count for policies with materially fewer sections in practice; rules in this release reference an EXISTING section by name (create it once in the Cato UI) - a strong candidate for a follow-up pass. |
| Custom Categories | `CustomCategoryRef`/`CustomCategoryRefInput` | Referenced pervasively by rules (`customCategory` fields), but the schema exposes NO mutation to create/update/delete one - only a by-id/by-name reference type. Not a gap in this app; there is no write API for it. |
| Site LAN Network Ranges + DHCP/routing | `site(accountId)` - `addNetworkRange`/`updateNetworkRange`/`removeNetworkRange`, `updateSiteNetworkRanges` | A DIFFERENT, site + LAN-socket-interface-scoped object from the account-level Global IP Range this app manages. Genuinely declarative (and does carry DHCP settings + a translated/NAT subnet), but resolving a site's LAN interface id requires a live, parent-scoped picker the platform's `remote-select` field doesn't yet support (options can't depend on another field's value in the same item) - deferred to a future pass rather than forcing users to paste opaque interface ids. |
| Static Hosts | `site(accountId)` - `addStaticHost`/`updateStaticHost`/`removeStaticHost`, `updateSiteStaticHosts` | Same site-scoping limitation as Site LAN Network Ranges above. |
| BGP Peers, WiFi SSIDs/radio profiles, IPsec IKEv2 sites, Cloud Interconnect | `site(accountId)` (various) | Physical/network-infrastructure provisioning tied to a specific socket/site appliance, not a pure policy-as-code surface - out of scope for this app (matches the "appliance/socket provisioning" exclusion applied across this codebase's other network-appliance apps). |
| Sites themselves (`addSocketSite`, `updateSiteGeneralDetails`, ...) | `site(accountId)` | Provisions/administers the physical or virtual socket appliance a site represents - a distinct onboarding workflow from authoring the security policy that targets an existing site. |
| Threat Prevention / IPS engine settings, events, incidents | `ThreatPrevention` (`MergedIncident`), `events`/`eventsFeed`/`appStats` | Read-only detection/analytics surfaces (signatures, incidents, telemetry) - not a declarative config-as-code write surface. Anti-Malware File Hash rules are the one genuinely writable slice of this domain. |
| Client Connectivity, Dynamic IP Allocation, Private Access, Remote Port Forwarding, Socket Bypass, Socket LAN, Split Tunnel, Terminal Server, WAN Network, ZTNA Always-On policies | `policy(accountId).<policyArea>` (each structurally identical to the rule types this app manages) | Real, staged, rule-based policies with the exact same shape as the ones covered here - deferred to keep this release focused on the core firewall/CASB/TLS surface; each is a strong, low-effort candidate for a follow-up pass reusing this app's generic rule/section pipeline (`config-types/lib/catoRulePipeline.ts` / `catoSectionPipeline.ts`). |
| Admins, Groups, Users, licensing, hardware management | `admin`/`groups`/`user`/`licensing`/`hardware` (various) | Account/tenant administration, not network-security policy - out of scope for this app. |
| Audit feed, events feed, account metrics/snapshots | `auditFeed`/`eventsFeed`/`accountMetrics`/`accountSnapshot` | Read-only observability - used internally by this app's connectivity test (`accountSnapshot`), never authored as config. |

Verified against `cato_api.graphqls` (the GraphQL schema `catonetworks/cato-go-sdk` and
`catonetworks/terraform-provider-cato` are both generated from/against) as of 2026-08.

## Health check

Handlers read the target policy (`policy(accountId).<policyArea>.policy { rules sections }`) or
object list (`customApplicationList` / `globalIpRangeList`) - a read that proves the API key is
valid and correctly scoped to the account together - before doing any per-configuration-type work.

## References

- Cato CMA API documentation: <https://api.catonetworks.com/documentation/>
- `catonetworks/cato-go-sdk` (source-of-truth GraphQL schema used to build this app - `cato_api.graphqls`, `cato.go`, `client.go`): <https://github.com/catonetworks/cato-go-sdk>
- `catonetworks/terraform-provider-cato` (verified the staged publish/revert workflow and the "no-op on PolicyRevisionNotFound" convention against its `policy_publish_application_control.go` / `policy_revision_retry.go`): <https://github.com/catonetworks/terraform-provider-cato>
