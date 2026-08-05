# SailPoint (Identity Security Cloud)

Manage **SailPoint Identity Security Cloud** (ISC, formerly IdentityNow)
configuration as code through the ISC API, with validation, drift detection and
rollback handled by the Veltrix Security-as-Code pipeline.

## Coverage (v0.6.0)

Coverage was audited against the SailPoint ISC OpenAPI specs
([`sailpoint-oss/api-specs`](https://github.com/sailpoint-oss/api-specs), `idn/v3`
and `idn/beta`) and [developer.sailpoint.com](https://developer.sailpoint.com) —
the ground-truth references for what the tenant API actually exposes. The
existing 30 configuration types (built across the 0.1.0 → 0.5.0 releases) were
confirmed complete for every mainstream declarative surface. This pass found
and added exactly one genuine gap: **Entitlements**, a governance-metadata
overlay — see below.

### Managed declarative configuration (31 types)

**Connectivity**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| Sources | `GET/POST/PATCH/DELETE /v3/sources` | Connector instances; JSON-Patch scalar updates; connector attributes are a secret-bearing JSON blob, applied on deploy but not drift-tracked. |
| Source Schemas | `GET/POST/PUT/DELETE /v3/sources/{id}/schemas` | Nested under a Source (resolved by name); keyed by schema name; full-replace PUT; reconcile scoped to the parent. |
| Provisioning Policies | `GET/POST/PUT/DELETE /v3/sources/{id}/provisioning-policies` | Nested under a Source; keyed by `usageType` enum; full-replace PUT per usage type. |
| Correlation Configs | `GET/POST/PUT/DELETE /v3/correlation-config` | Account correlation attribute assignments; full-replace PUT. |
| Managed Clusters | `GET/POST/PATCH/DELETE /v3/managed-clusters` | VA cluster records only — the appliance itself still needs manual bootstrap. |

**Identity Governance**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| Identity Profiles | `GET/POST/PATCH/DELETE /v3/identity-profiles` | Authoritative-source-driven identity construction; JSON-Patch updates; authoritative source immutable. |
| Lifecycle States | `GET/POST/PATCH/DELETE /v3/identity-profiles/{id}/lifecycle-states` | Nested under an Identity Profile; keyed by `technicalName`; JSON-Patch updates. |
| Identity Attributes | `GET/POST/PUT/DELETE /beta/identity-attributes` | Custom identity attributes, name-keyed; full-replace PUT; standard/system attributes protected. |
| Search Attributes | `GET/POST/PATCH/DELETE /v3/accounts/search-attribute-config` | Extended search attributes, name-keyed; POST create / JSON-Patch update. |
| Roles | `GET/POST/PATCH/DELETE /v3/roles` | Bundle Access Profiles to grant access; JSON-Patch updates; role membership (auto-assignment) out of scope. |
| Access Profiles | `GET/POST/PATCH/DELETE /v3/access-profiles` | Bundle entitlements from a single Source; source immutable; an enabled profile must grant at least one entitlement. |
| Role Dimensions | `GET/POST/PATCH/DELETE /beta/roles/{id}/dimensions` | Nested under a Role; keyed by dimension name; JSON-Patch updates. |
| **Entitlements** | `GET /beta/entitlements` (filtered lookup), `PATCH /beta/entitlements/{id}` | **New in v0.6.0.** Governance overlay on an already-discovered entitlement — see below. |
| Segments | `GET/POST/PATCH/DELETE /segments/v1` | Id-addressed with no name filter, so the app lists all and matches by name, storing the id. |
| Governance Groups | `GET/POST/PATCH/DELETE /workgroups/v1` | Workgroups — name, description, owner Identity; membership managed separately in ISC. |

**Policy & Compliance**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| SOD Policies | `GET/POST/PUT/DELETE /v3/sod-policies` | Separation-of-duties policies (GENERAL query or CONFLICTING_ACCESS_BASED criteria); full-replace PUT. |
| Password Policies | `GET/POST/PUT/DELETE /v3/password-policies` | Length, composition, expiration and strength rules; full-replace PUT; the tenant default policy is protected. |
| Password Sync Groups | `GET/POST/PUT/DELETE /v3/password-sync-groups` | References a password policy and a set of synced sources; full-replace PUT. |
| Campaign Templates | `GET/POST/PATCH/DELETE /v3/campaign-templates` | Certification campaign templates (not runs); embedded campaign is a normalized JSON blob; schedule out of scope. |
| MFA Configuration | `GET/PUT/DELETE /v3/mfa/{method}/config` | Duo and Okta Verify per-method singletons; `configProperties` secret-bearing, applied on deploy but not drift-tracked. |
| Tenant Configuration | `GET/PUT` or `GET/PATCH` across 8 singleton endpoints (access-request-config, password-org-config, public-identities-config, org-config, `auth-org/{lockout,session,network,service-provider}-config`) | Read+replace with a prior snapshot; reverted on rollback or when a setting is undeclared. |

**Automation & Integration**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| Workflows | `GET/POST/PUT/PATCH/DELETE /v3/workflows` | Created disabled then PATCH-enabled; full-replace PUT for updates; trigger/definition are JSON blobs (drift on scalars only). |
| Trigger Subscriptions | `GET/POST/PATCH/DELETE /beta/trigger-subscriptions` | HTTP and EventBridge event delivery; HTTP config secret-bearing, applied on deploy but not drift-tracked. |
| Connector Rules | `GET/POST/PUT/DELETE /beta/connector-rules` | BeanShell cloud rules; full-replace PUT; rule type immutable. |
| Service Desk Integrations | `GET/POST/PATCH/DELETE /v3/service-desk-integrations` | Connection attributes secret-bearing, applied on deploy but not drift-tracked. |
| SIM Integrations | `GET/POST/PATCH/DELETE /beta/sim-integrations` | Connection attributes secret-bearing, applied on deploy but not drift-tracked. |
| Notification Templates | `GET/POST /beta/notification-templates`, `POST /beta/notification-templates/bulk-delete` | Composite-keyed by key+medium+locale; create replaces the override (no PATCH/PUT); reconcile bulk-deletes app-created triples. |
| Verified From-Addresses | `GET/POST/DELETE /beta/verified-from-addresses` | Email-keyed; create/delete only; SES verification is out-of-band so drift reports pending. |

**Applications & Non-Employees**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| Source Apps | `GET/POST/PATCH/DELETE /beta/source-apps` | Access-request applications; JSON-Patch updates; account source immutable. |
| Non-Employee Sources | `GET/POST/PATCH/DELETE /beta/non-employee-sources` | The source container only — individual non-employee records are per-user and out of scope. |

**Original release**

| Configuration type | ISC API | Notes |
| --- | --- | --- |
| Transforms | `GET/POST/PUT/DELETE /transforms/v1` | Identity-attribute transformation logic; built-in (internal) transforms protected; a same-name transform of a different `type` is rejected, never silently replaced. |

### Entitlements (new in v0.6.0)

Entitlements are discovered by **source aggregation** — this app never creates
or deletes one through the API (`POST /beta/entitlements` is SailPoint's own
internal-only `createEntitlement` endpoint and is deliberately not used). What
`PATCH /beta/entitlements/{id}` *does* expose is a well-defined,
general-availability governance overlay: `name`,
`description`, `requestable`, `privileged`, `owner`, `segments` and
`manuallyUpdatedFields` (whether a later source aggregation is allowed to
overwrite the declared name/description). That overlay was completely
unmanaged despite three other configuration types in this app already
referencing entitlements by id (Access Profiles, Role Dimensions, SOD
Policies) — flagging privileged/high-risk access and assigning an accountable
owner is a core IGA control, so this was the clearest sourced gap in the app.

Each canvas item is matched to a live entitlement within a named Source by the
entitlement's own `name` (optionally disambiguated by its schema `attribute`
when two entitlements on one source share a name), with the id cached after
the first match for rename-safety — the same pattern Access Profiles and
Lifecycle States use for their own name-matched, id-cached objects. Because
this app never owns creation, an item removed from the canvas **reverts the
overlay to its prior values** rather than deleting anything — the same
non-destructive reconcile MFA Configuration and Tenant Configuration already
use for objects this app doesn't create either. Given entitlement counts can
run into the thousands per source, lookups use ISC's `filters` query
(`source.id eq "…" and name eq "…"`) scoped to the declared item rather than
listing every entitlement in the tenant.

### Intentionally excluded surfaces

- **Certification campaign runs and decisions** (`POST /v3/campaigns`,
  `campaign-activate`, `campaign-complete`, `identity-certifications-decide`,
  `-sign-off`, `-reassign`) are one-shot launches and in-review actions against
  a point-in-time snapshot of access, not durable desired state. Campaign
  **Templates** (the reusable schedule/definition) are managed; a template's
  actual runs are not.
- **Non-employee records** (`GET/POST/PUT/DELETE /beta/non-employee-records`)
  are per-user records tied to an individual non-employee, not tenant
  configuration — only the Non-Employee **Source** container is managed.
- **Access Requests and approvals** (`POST /v3/access-requests`,
  `pending-access-request-approvals`, `approve-/reject-access-request-approval`)
  are imperative request/approval workflow actions, not configuration.
- **Read-only reference data** with no create/update/delete operation:
  Accounts, Identities, Connectors (the built-in connector catalog), Source
  Health/Usage, Requestable Object List, Reports, Search, and Work Items.
- **Secret material is never round-tripped.** Where a managed type carries a
  secret — Source `connectorAttributes`, Service Desk/SIM Integration
  connection attributes, Trigger Subscription HTTP config, MFA
  `configProperties` — the value is accepted on write but never read back,
  diffed for drift, or restored on rollback, consistent with how every
  credential-bearing type in this app already documents itself.
- **OAuth Clients** (`GET/POST/PATCH/DELETE /v3/oauth-clients`) — full CRUD is
  available, but an app that can create or rotate the very class of OAuth
  client that grants tenant API access is a deliberate self-referential
  bootstrap-security boundary this app declines to cross (the same reasoning
  this catalog's `crowdstrike-edr` app documents for its own API Clients &
  Keys exclusion).
- **Certification Campaign Filters** (`GET/POST /v3/campaign-filters` — create,
  list, and update all via POST; bulk delete via a dedicated POST endpoint) —
  a fully CRUD-capable, reusable set of inclusion/exclusion criteria for
  scoping certification campaigns. No API blocker rules it out; it was
  evaluated during this pass and is noted here as a viable candidate for a
  future configuration type rather than folded into this conservative,
  confirmatory release.

Field-level detail for every configuration type — required fields, defaults,
help text — lives in its `canvas.yaml` and `validate.ts` under
`config-types/<type>/`.

## Authentication

ISC authenticates via **OAuth2 client credentials**. Store the credential as:

- **Username** → ISC **Client ID** (a Personal Access Token's Client ID, or an
  API-management OAuth client id)
- **Password** → ISC **Client Secret**

Generate a PAT from an **ORG_ADMIN** user (config endpoints require ORG_ADMIN)
with the relevant `:manage` / `:read` scopes for what this app manages (e.g.
`idn:transform:manage`, `idn:entitlement:manage`). Set the tenant **org name**
(e.g. `acme`) in the app's **Tenant** setting — the API is reached at
`https://{org}.api.identitynow.com`. For non-standard hosts, use the optional
**API URL** override setting.

The app exchanges these for a bearer token (`POST /oauth/token`,
`grant_type=client_credentials`) and caches it until just before expiry. List
endpoints paginate with `offset`/`limit` (max 250); rate limiting (429) is
honored via `Retry-After`.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs sailpoint

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/sailpoint
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## Research sources

- [`sailpoint-oss/api-specs`](https://github.com/sailpoint-oss/api-specs) —
  the OpenAPI specs backing `developer.sailpoint.com`; `idn/v3` and `idn/beta`
  path/schema definitions are ground truth for this audit.
- [`idn/beta/paths/ears-entitlement.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/beta/paths/ears-entitlement.yaml) —
  `patchEntitlement` operation confirming the patchable field set (`requestable`,
  `privileged`, `segments`, `owner`, `name`, `description`,
  `manuallyUpdatedFields`) behind the new Entitlements type.
- [`idn/beta/paths/entitlement.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/beta/paths/entitlement.yaml) —
  confirms `createEntitlement` is documented as an internal endpoint, the basis
  for never creating entitlements through this app.
- [`idn/v3/paths/oauth-clients.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/v3/paths/oauth-clients.yaml) /
  [`oauth-client.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/v3/paths/oauth-client.yaml) —
  full CRUD confirmed available; excluded as a deliberate security boundary
  (see Coverage).
- [`idn/v3/paths/campaign-filters.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/v3/paths/campaign-filters.yaml) /
  [`campaign-filter.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/v3/paths/campaign-filter.yaml) /
  [`campaign-filters-delete.yaml`](https://github.com/sailpoint-oss/api-specs/blob/main/idn/v3/paths/campaign-filters-delete.yaml) —
  full CRUD confirmed available; noted as a future-candidate type (see
  Coverage), not built this pass.

## License

Apache-2.0
