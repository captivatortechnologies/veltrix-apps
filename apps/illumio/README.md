# Illumio

Manage **Illumio Core** (Policy Compute Engine) microsegmentation configuration
as code through the Illumio REST API v2, with validation, drift detection and
rollback handled by the Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | PCE surface | Identity | Notes |
|---|---|---|---|
| **Labels** | `/orgs/{org_id}/labels` | (key, value) pair | Key/value policy objects (role, app, env, loc, or a custom dimension). |
| **IP Lists** | `/orgs/{org_id}/sec_policy/draft/ip_lists` | name | Named IP/CIDR ranges and/or FQDNs. Draft → provision. |
| **Services** | `/orgs/{org_id}/sec_policy/draft/services` | name | Named TCP/UDP/ICMP port definitions. Draft → provision. |
| **Label Groups** | `/orgs/{org_id}/sec_policy/draft/label_groups` | name | Named sets of same-dimension labels. Draft → provision. |
| **Virtual Services** | `/orgs/{org_id}/sec_policy/draft/virtual_services` | name | A named port group (or existing Service) workloads classify under. Draft → provision. |
| **Rulesets** | `/orgs/{org_id}/sec_policy/draft/rule_sets` (+ `.../sec_rules`) | name (rules: content signature) | A label scope plus rules referencing labels/IP lists/services by name. Draft → provision. |
| **Enforcement Boundaries** | `/orgs/{org_id}/sec_policy/draft/enforcement_boundaries` | name | Deny-by-default rules — providers/consumers/services directly on the object, no scope wrapper. Draft → provision. |
| **Pairing Profiles** | `/orgs/{org_id}/pairing_profiles` | name | VEN onboarding templates. **Not** draft/provision — takes effect immediately. |

Labels have no draft/active split — a label's identity is its **(key, value)
pair**, `key` is immutable in the PCE once created, and optional
`external_data_set` / `external_data_reference` metadata is synced on labels
that already exist.

IP lists, services, label groups, virtual services, rulesets and enforcement
boundaries are **security policy** and live under the PCE's
**DRAFT → PROVISION** model:

1. Every write (create/update/delete) goes to
   `/orgs/{org_id}/sec_policy/draft/<resource>` first — nothing takes effect
   yet.
2. In the same deploy, this app **provisions** every href it touched:
   `POST /orgs/{org_id}/sec_policy { update_description, change_subset }`,
   where `change_subset.{ip_lists,services,rule_sets,label_groups,
   virtual_services,enforcement_boundaries}` is the array of changed
   `{href}`s. This commits those changes into a new **active** policy version.
3. Rollback restores/removes the draft objects it touched and **re-provisions**
   that undo the same way — an unprovisioned rollback would leave the PCE
   still enforcing the old (rolled-back-from) policy.

Confirmed against the Illumio Terraform provider's own provisioning tool
(`cmd/provision/main.go`, which collects the hrefs `terraform apply` changed
and POSTs exactly this) and `models.SecurityPolicy` /
`SecurityPolicyChangeSubset`.

**Pairing Profiles are the one exception**: `/orgs/{org_id}/pairing_profiles`
has no `draft` path segment, and the Terraform provider's pairing-profile
resource never calls `StoreHref` (the hook it uses everywhere else to track a
change for later provisioning) — writes take effect immediately, the same
posture as Labels.

Most types are matched by **name** (like a FortiManager-style name-keyed
object) — labels by their (key, value) pair instead; reconcile only deletes
objects this app created but no longer declares. **Rules** (nested under a
ruleset) have no natural identity in the PCE, so this app matches them by a
**content signature** of their resolved shape (providers, consumers,
services, enabled, description) instead — see
`config-types/rulesets/_shared.ts`.

### Rulesets — scope and rule DSL

A ruleset's rules reference labels, IP lists and services **by name**; deploy
resolves every reference to the PCE's internal href and **fails closed**: if
any reference can't be resolved, that entire ruleset is skipped (nothing
partial is applied) and reported as a failure, rather than deploying an
under-scoped or under-restricted rule.

```json
{
  "providers": [{ "label": { "key": "role", "value": "R-Web" } }],
  "consumers": [{ "label": { "key": "role", "value": "R-DB" } }],
  "services": [{ "name": "HTTPS" }]
}
```

Each provider/consumer sets **exactly one** of `label` ({key,value}), `ipList`
(an existing IP list's name), or `allWorkloads: true` (the PCE's "All
Workloads" actor, `ams`) — mirroring the PCE's own `HasOneActor` rule.

> **Out of scope for this release** (flagged, not faked):
> - **Custom label dimensions** (`/orgs/{org_id}/label_dimensions`, PCE
>   22.5+) — a label's `key` must already exist as one of the PCE's four
>   built-in dimensions (`role`, `app`, `env`, `loc`) or a custom dimension
>   created directly in the PCE.
> - **Workloads, virtual services, virtual servers and label groups** as rule
>   actors — only label, IP list, and "All Workloads" are supported.
> - **Multiple OR'd scope groups** — a ruleset has exactly one scope (one
>   AND-group of labels); the PCE's real `scopes` shape is `[][]RuleSetScope`
>   (OR of AND-groups).
> - **Windows services / Windows egress services** on the Services type.
> - `ip_tables_rules`, `sec_connect`, `stateless`, `machine_auth`,
>   `unscoped_consumers`, `use_workload_subnets` on rulesets.
> - **Full per-rule rollback** — rollback reverses rule *creates* (by
>   deleting them) and restores ruleset-level metadata, but does not restore
>   a rule a deploy *removed* (its prior body isn't captured). Re-deploying
>   the desired canvas state is the reliable recovery path for a rule
>   removal you want undone.

## Authentication

Illumio authenticates with a **PCE API key** over HTTP Basic auth — the same
scheme the Illumio Python SDK (`pce.set_credentials(key, secret)`) and
Terraform provider use. Store the credential as:

- **API key username** → the API key (e.g. `api_145a5c788e2ba897c`)
- **API key secret** → the key's secret

Set the PCE **host**, **port** (default `8443`), **organization ID** (default
`1`) and **Verify TLS certificate** (off by default — on-premises PCEs
commonly ship a self-signed or internal-CA certificate) in the app's settings;
a Veltrix installation manages one PCE, so these are app-level settings rather
than per-connection fields.

## Configuration types

**Labels** — each item is `key` (≤ 64 chars) + `value`, plus optional
`external_data_set` / `external_data_reference`.

**IP Lists** — each item is a `name` (≤ 255 chars) plus `ip_ranges` and/or
`fqdns`, each a JSON array (e.g.
`[{"fromIp":"10.0.0.0/8"}]` / `[{"fqdn":"*.example.com"}]`) — at least one is
required.

**Services** — each item is a `name` (≤ 255 chars) plus `service_ports`, a JSON
array of `{proto, port?, toPort?, icmpType?, icmpCode?}` (proto-dependent field
rules enforced in `validate.ts`, mirroring the PCE's own constraints).

**Label Groups** — each item is a `name` (≤ 255 chars), a `key` (the
dimension every member must share, ≤ 64 chars), and `labels` (a JSON array of
`{key,value}` refs — each must share the group's `key`).

**Virtual Services** — each item is a `name` (≤ 255 chars), `applyTo`
(`host_only` | `internal_bridge_network`), and **exactly one** of
`serviceName` (an existing Service, by name) or `servicePorts` (a JSON array
of `{proto, port?, toPort?}`, TCP/UDP only). Optional `labels` and
`ipOverrides` (a flat tag list of IPs/CIDRs).

**Enforcement Boundaries** — each item is a `name` (≤ 255 chars), `providers`
and `consumers` (each a JSON array of the actor DSL below — at least one),
and `services` (a JSON array of `{name}` service refs — at least one).

**Rulesets** — each item is a `name` (≤ 255 chars), one scope (`scopeLabels`,
a JSON array of `{key,value}` label refs — at least one), and `rules` (a JSON
array of the rule DSL above — at least one).

**Pairing Profiles** — each item is a `name` (≤ 255 chars), `enabled`,
`enforcementMode` (`idle`|`visibility_only`|`full`|`selective`),
`allowedUsesPerKey` / `keyLifespan` (`"unlimited"` or an integer),
`visibilityLevel` (optional), the four per-dimension label locks
(`envLabelLock`/`locLabelLock`/`roleLabelLock`/`appLabelLock`), `logTraffic` /
`logTrafficLock`, `enforcementModeLock` / `visibilityLevelLock`, and optional
`labels` (a JSON array of `{key,value}` refs applied to every VEN paired with
this profile).

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs illumio

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/illumio
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## References

- Illumio Core REST API guide (labels & label groups):
  https://docs.illumio.com/core/23.2/Content/Guides/security-policy/security-policy-objects/labels-and-label-groups.htm
- `illumio-py` (official Python SDK) — base URL, org scoping, Basic auth, TLS
  verification, connectivity check:
  https://github.com/illumio/illumio-py
- `terraform-provider-illumio-core` — resource/data-source schemas for labels,
  IP lists, services, rule sets and security rules; the provisioning CLI tool
  and `SecurityPolicy`/`SecurityPolicyChangeSubset` models:
  https://github.com/illumio/terraform-provider-illumio-core
  - `illumio-core/resource_illumio_ip_list.go`, `models/ip_list.go`
  - `illumio-core/resource_illumio_service.go`, `models/service.go`
  - `illumio-core/resource_illumio_rule_set.go`, `models/rule_set.go`
  - `illumio-core/resource_illumio_security_rule.go`, `models/security_rule.go`
  - `illumio-core/resource_illumio_label_group.go`, `models/label_group.go`
  - `illumio-core/resource_illumio_enforcement_boundary.go`,
    `models/enforcement_boundary.go`
  - `illumio-core/resource_illumio_virtual_service.go`,
    `models/virtual_service.go`
  - `illumio-core/resource_illumio_pairing_profile.go`,
    `models/pairing_profile.go`
  - `cmd/provision/main.go`, `models/security_policy.go` (the draft →
    provision flow)

## Coverage

An inventory of the Illumio Core PCE's config-as-code-relevant surface (audited
against `illumio-py` and every resource in `terraform-provider-illumio-core`),
and what this app manages vs. intentionally excludes.

### Managed

| PCE object | Config type | Notes |
|---|---|---|
| Labels | **Labels** | (key, value) identity; no draft/provision. |
| IP Lists | **IP Lists** | Name-keyed; draft → provision. |
| Services | **Services** | Name-keyed; draft → provision. |
| Label Groups | **Label Groups** | Name-keyed; member labels resolved by key+value, fail closed; draft → provision. |
| Virtual Services | **Virtual Services** | Name-keyed; optional Service/label refs resolved by name, fail closed; draft → provision. |
| Rule Sets + Security Rules | **Rulesets** | Name-keyed ruleset + content-signature-keyed nested rules; every provider/consumer/service reference resolved by name, fail closed; draft → provision. |
| Enforcement Boundaries | **Enforcement Boundaries** | Name-keyed; every provider/consumer/service reference resolved by name, fail closed; draft → provision. |
| Pairing Profiles | **Pairing Profiles** | Name-keyed VEN onboarding templates; member label refs resolved by name, fail closed. **No** draft/provision — takes effect immediately (no `StoreHref` call anywhere in the Terraform provider's pairing-profile resource, unlike every other resource above). |

### Intentionally excluded (drop, don't fake)

| PCE surface | Why excluded |
|---|---|
| **Workloads / VENs** (`workload.go`, `ven.go`, managed & unmanaged workload resources) | A workload's canonical record is **agent-reported** — created by the VEN pairing process and continuously updated by the running agent, not something an admin declares as desired state the way a label or ruleset is. Modeling it as a canvas item would fight the agent for ownership of fields it actively reports (hostname, IP, OS, running services). |
| **Pairing Keys** (`resource_illumio_pairing_keys.go`) | A pairing key is short-lived, one-time (or limited-use) **credential material** generated *from* a Pairing Profile at pairing time — closer to a secret than a config object. This app manages the reusable profile; keys are minted by the pairing script itself. |
| **Virtual Servers** (referenced in `models.SecurityPolicyChangeSubset.VirtualServers` but with no exposed create/update resource in the Terraform provider) | Represents an integration with an external load balancer / SLB (F5, NetScaler, etc.) via Illumio's NEN (Network Enforcement Node) — the server-side object is populated by that SLB integration, not authored directly. Out of scope without a live SLB integration to verify against. |
| **Custom Label Dimensions** (`label_dimensions` API / `resource_illumio_label_type.go`, PCE 22.5+) | A tenant-schema object gated behind a specific PCE version, changing what values are even legal for a label's `key`. The four built-ins (`role`, `app`, `env`, `loc`) always exist and are all this app assumes; a label referencing a custom key must have that dimension created directly in the PCE first. |
| **Organization / Firewall / Traffic Collector Settings** (`organization_settings.go`, `firewall_settings.go`, `traffic_collector_settings.go`) | PCE-wide **singletons**, not independently identity-bearing collections — there is exactly one per org, so "declare N items, reconcile the rest away" (this app's whole reconcile model) doesn't apply, and blanket-replacing global settings through a multi-item canvas is a foot-gun, not a feature. |
| **Service Bindings** (`resource_illumio_service_binding.go`) | Binds a Virtual Service to specific **workload** instances — since workloads themselves are excluded (agent-reported), a binding to them is equally out of scope. |
| **Container Cluster / Kubelink integration** (`container_cluster.go`, `container_cluster_workload_profile.go`) | Requires a live Kubernetes cluster registered with the PCE (a Kubelink connection) to mean anything; infrastructure-specific and unverifiable without one. |
| **VEN/Workload lifecycle actions** (`vens_unpair.go`, `vens_upgrade.go`, `workloads_unpair.go`) | Runtime **actions** (unpair, upgrade), not declarative state — there is nothing to "reconcile" for an imperative one-shot operation. |
| **Vulnerability data** (`vulnerabilities.go`, `vulnerability_report.go`) | Read-only computed/imported data (e.g. from a vulnerability scanner integration), not something this app creates. |
| **Syslog Destinations** (`syslog_destination.go`) | A genuine name-keyed, list-shaped object this audit found and did **not** build — flagged here rather than silently omitted. A reasonable candidate for a future release; not verified against a live PCE in this one. |

### Known simplifications within what IS managed (see each config type's own docs above)

Label group sub-groups; enforcement-boundary actors beyond label/IP-list/"All
Workloads"; virtual-service `service_addresses` and Windows services;
multiple OR'd ruleset scope groups; `ip_tables_rules` /
`sec_connect`/`stateless`/`machine_auth`/`unscoped_consumers`/
`use_workload_subnets` on rulesets; full per-rule rollback (a removed rule's
prior body isn't captured, only creates are reversed).
