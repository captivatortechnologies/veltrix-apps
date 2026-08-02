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
| **Rulesets** | `/orgs/{org_id}/sec_policy/draft/rule_sets` (+ `.../sec_rules`) | name (rules: content signature) | A label scope plus rules referencing labels/IP lists/services by name. Draft → provision. |

Labels have no draft/active split — a label's identity is its **(key, value)
pair**, `key` is immutable in the PCE once created, and optional
`external_data_set` / `external_data_reference` metadata is synced on labels
that already exist.

IP lists, services and rulesets are **security policy** and live under the
PCE's **DRAFT → PROVISION** model:

1. Every write (create/update/delete) goes to
   `/orgs/{org_id}/sec_policy/draft/<resource>` first — nothing takes effect
   yet.
2. In the same deploy, this app **provisions** every href it touched:
   `POST /orgs/{org_id}/sec_policy { update_description, change_subset }`,
   where `change_subset.{ip_lists,services,rule_sets}` is the array of changed
   `{href}`s. This commits those changes into a new **active** policy version.
3. Rollback restores/removes the draft objects it touched and **re-provisions**
   that undo the same way — an unprovisioned rollback would leave the PCE
   still enforcing the old (rolled-back-from) policy.

Confirmed against the Illumio Terraform provider's own provisioning tool
(`cmd/provision/main.go`, which collects the hrefs `terraform apply` changed
and POSTs exactly this) and `models.SecurityPolicy` /
`SecurityPolicyChangeSubset`.

IP lists and services are matched by **name** (like a FortiManager-style
name-keyed object); reconcile only deletes objects this app created but no
longer declares. **Rules** have no natural identity in the PCE, so this app
matches them by a **content signature** of their resolved shape (providers,
consumers, services, enabled, description) instead — see
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

**Rulesets** — each item is a `name` (≤ 255 chars), one scope (`scopeLabels`,
a JSON array of `{key,value}` label refs — at least one), and `rules` (a JSON
array of the rule DSL above — at least one).

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
  - `cmd/provision/main.go`, `models/security_policy.go` (the draft →
    provision flow)
