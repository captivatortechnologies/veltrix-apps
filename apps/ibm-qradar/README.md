# IBM QRadar

Manage **IBM QRadar** configuration as code through the QRadar REST API, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

24 configuration types across reference data, log sources, event/flow
properties, network topology, access/tenancy, offenses, Ariel/AQL and disaster
recovery. See **[Coverage](#coverage)** below for the full list, grouped, plus
every QRadar surface this app deliberately does **not** manage and why.

## Authentication

QRadar authenticates with an **authorized-service token**. In **Admin >
Authorized Services**, create a service with a role that has reference-data
(admin) permission and copy its token. Store the credential as:

- **Password** → the authorized-service token

The app sends it in the `SEC` header on every request, plus a `Version` header
pinning the API version. Set the **Console Host** (e.g. `qradar.example.com`) and
**API Version** (default `20.0`) in the app's settings.

> **TLS note:** this app uses the standard TLS stack, so the QRadar console must
> present a certificate the host trusts (a valid CA chain).

## Coverage

### Managed configuration types (24)

Grouped as they appear in the Configuration Canvas (`group:` in
`manifest.yaml`):

**Reference Data** — `/reference_data/*` (classic name-keyed reference-data
API; element/value type immutable after create)
- Reference Sets — named, typed value collections
- Reference Maps — named, typed key=value collections
- Map of Sets — named collections where each key holds a set of values
- Reference Tables — named `outer key -> column -> value` collections with typed columns

**Log Sources** — `/config/event_sources/log_source_management/*`, `/data_classification/*`
- Log Sources — named event feeds (type + protocol declared by name, resolved to ids)
- Custom Log Source Types — named DSMs; only custom types are managed, built-ins are protected
- Log Source Groups — named folders in the group hierarchy (parent by name); **append-only** — create + read only, no update/delete
- QID Records — normalized event definitions with nested DSM event mappings; **append/update-only** — no delete

**Event & Flow Properties** — `/config/event/custom_properties/*`, `/config/flow/custom_properties/*`, `/config/event_sources/custom_properties/calculated_properties`
- Custom Event Properties — regex property + per-log-source-type extraction expressions
- Flow Custom Properties — the same, scoped to flow records
- Calculated Event Properties — a value computed from two operands and an operator

**Network & Topology** — `/staged_config/remote_networks`, `/staged_config/remote_services`, `/config/network_hierarchy/staged_networks` (staged; applied with an INCREMENTAL deploy)
- Remote Networks — named CIDR ranges classifying external traffic
- Remote Services — named CIDR ranges classifying known-service traffic
- Network Hierarchy — grouped named CIDR objects (whole-list staged replace preserving operator objects)

**Access & Tenancy** — `/config/access/tenant_management/*`, `/config/domain_management/*`, `/config/resource_restrictions`
- Tenants — named multi-tenancy boundaries with optional rate limits
- Domains — named segmentation boundaries with a description
- Resource Restrictions — data-window/execution-time/record-limit caps for a tenant or role (scope limited to tenant/role targets)

**Offenses** — `/siem/offense_closing_reasons`
- Offense Closing Reasons — short analyst-selectable close texts; **append-only** — no update/delete

**System** — `/bandwidth_manager/configurations`
- Bandwidth Manager — store-and-forward traffic-shaping caps per managed host (filters out of scope)

**Ariel / AQL** — `/ariel/*`
- Ariel Lookups — named key=value maps (+ default value) used by AQL expressions; field type immutable
- Tagged Field Categories — named UI groupings for Ariel tagged fields; rename-safe by id
- Tagged Fields — named IPFIX/NetFlow information elements usable in AQL; name/type/private-enterprise-number/element-id/is-array **immutable after creation** (only category + description update in place)
- Flow VLANs — enterprise/customer VLAN id pairs disambiguating overlapping VLAN spaces; **no name field, no update** — the pair itself is the identity

**Disaster Recovery** — `/disaster_recovery/ariel_copy_profiles`
- Disaster Recovery Ariel Copy Profiles — continuous event/flow replication from a managed host to a DR destination; QRadar allows one profile per host, so `host_id` is the real identity

### Intentionally excluded

Reviewed against the QRadar REST API (versions 20.0 and 27.0 endpoint docs,
`ibmsecuritydocs.github.io/qradar_api_<version>`) and excluded because the
write surface is narrow/read-only, one-shot, or carries secret material:

| Surface | Endpoint(s) | Why excluded |
|---|---|---|
| Custom Rules | `GET/POST({id})/DELETE({id}) /analytics/rules` | No create endpoint. The `{id}` POST is documented as "Updates the rule owner or enabled/disabled only" — rule logic (tests/actions) has no write API. |
| Building Blocks | `GET/POST({id})/DELETE({id}) /analytics/building_blocks` | Same pattern — `{id}` POST only updates owner/enabled. No create. |
| Rule Groups | `GET /analytics/rule_groups`, `GET/POST/DELETE({group_id})` | No plain-POST create. The `{group_id}` POST is documented as "Updates the owner of a rule group" only. |
| Ariel Saved Searches | `GET/POST({id})/DELETE({id}) /ariel/saved_searches` | No create endpoint. The `{id}` POST updates only `is_shared`, `owner`, `is_quick_search`, `is_default`, `is_dashboard` — never the AQL/query itself. A saved search is only produced as a side effect of running a live query (`POST /ariel/searches`, see below), not declared directly. |
| Ariel Searches | `POST /ariel/searches` | Executes an AQL query against live event/flow data — a one-shot runtime action, not idempotent config-as-code. |
| Event/Flow Retention Buckets | `GET/POST({id})/DELETE({id}) /config/event_retention_buckets`, `/config/flow_retention_buckets` | No plain-POST create — buckets are a fixed, GUI-provisioned set (`bucket_id` 0-10). The `{id}` POST is documented as "Updates the event retention bucket owner or enabled/disabled only." Read-only here to resolve bucket **names** for the Disaster Recovery Ariel Copy Profile exclude-list fields. |
| Store & Forward Policies | `GET/POST({id})/DELETE({id}) /config/store_and_forward/policies` | No plain-POST create. The `{id}` POST is documented as "Updates the store and forward policy owner only." This is QRadar's internal event/flow scheduling between managed hosts, not the GUI's Forwarding Destinations/Routing Rules feature. |
| Forwarding Destinations / Routing Rules | *(none found)* | The classic Admin > System Configuration GUI feature for exporting events/flows off-box (Syslog/SNMP/JSON) has no REST API endpoint in the documented surface — confirmed by a full endpoint-tree search across every `qradar_api_*` version repository. |
| User Roles | `GET /config/access/user_roles`, `GET /staged_config/access/user_roles` (+ `/{id}`) | Read-only in both the deployed and staged config APIs. Already used read-only (name → id) for the Resource Restrictions target lookup. |
| Security Profiles | `GET /config/access/security_profiles`, `GET /staged_config/access/security_profiles` (+ `/{id}`) | Read-only in both APIs — no write endpoint exists. |
| Users | `POST /staged_config/access/users` (+ `{id}` update/delete) | The one exception with a genuinely full write API (staged create/update/delete + deploy). Intentionally out of scope: creating a user accepts a settable `password` field (secret material), and identity/account lifecycle is treated as an IdP/LDAP/SAML concern rather than declarative security config in this app. |

## Example configuration type: Reference Sets

One of the 24 managed types, shown in full as a worked example. Each canvas
item is one reference set:

- **Name** — the set identity (unique in the canvas).
- **Element Type** — `ALN`, `ALNIC`, `IP`, `NUM`, `PORT`, or `DATE` (immutable
  after create).
- **Values** — one value per line, reconciled to exactly this list.

Reference sets are matched by **name** (the classic reference-data API is
name-keyed). Deploy reads the live set, reconciles its **values** to exactly
the declared list (adds missing, removes extra), and creates the set if
absent. The **element type is immutable**, so a same-name set of a different
type is not modified. Reconcile only deletes sets this app created but no
longer declares.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs ibm-qradar

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/ibm-qradar
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
