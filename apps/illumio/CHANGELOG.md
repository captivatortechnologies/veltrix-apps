# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.2.0 — 2026-08-02

### Added

- **DRAFT → PROVISION** support in `lib/illumioApi.ts`: `secPolicyDraftPath()`
  for the `/orgs/{org_id}/sec_policy/draft/<resource>` object surface, and
  `provisionChanges()` — `POST /orgs/{org_id}/sec_policy { update_description,
  change_subset }` to commit a batch of changed hrefs into a new active policy
  version. Confirmed against the Illumio Terraform provider's own
  provisioning tool (`cmd/provision/main.go`) and `models.SecurityPolicy` /
  `SecurityPolicyChangeSubset`.
- **IP Lists** configuration type — named IP/CIDR ranges and/or FQDNs
  (`/orgs/{org_id}/sec_policy/draft/ip_lists`), name-keyed and upserted, with
  the full pipeline handler set. Every draft write (create/update/delete) is
  provisioned in the same deploy; rollback restores/removes and re-provisions.
- **Services** configuration type — named TCP/UDP/ICMP port definitions
  (`/orgs/{org_id}/sec_policy/draft/services`), name-keyed, with proto-
  dependent field validation mirroring the PCE's own rules (icmp fields only
  for ICMP/ICMPv6, port/toPort only for TCP/UDP). Draft → provision, same as
  IP Lists.
- **Rulesets** configuration type — a label scope plus security rules
  (`/orgs/{org_id}/sec_policy/draft/rule_sets`, rules at
  `{rule_set_href}/sec_rules`). Rules reference labels (key+value), IP lists
  and services **by name**; deploy resolves every reference to a PCE href and
  **fails closed** — an unresolved reference skips the whole ruleset rather
  than deploying a partial rule. Rules have no natural PCE identity, so
  reconcile matches them by a content signature of their resolved shape.
  Draft → provision, same as IP Lists/Services.
- `group:` added to every configuration type's sidebar grouping — Labels/IP
  Lists/Services under **Policy Objects**, Rulesets under **Security Policy**.

### Deferred / out of scope (flagged, not faked)

- Custom label dimensions (`label_dimensions` API, PCE 22.5+) — a label's
  `key` must reference an existing built-in or custom dimension.
- Workloads, virtual services, virtual servers and label groups as rule
  actors; multiple OR'd ruleset scope groups; Windows services on the
  Services type; `ip_tables_rules` / `sec_connect` / `stateless` /
  `machine_auth` / `unscoped_consumers` / `use_workload_subnets` on rulesets.
- Full per-rule rollback — reverses rule creates and restores ruleset-level
  metadata, but does not restore a rule a deploy removed (its prior body
  isn't captured).

## 0.1.0 — 2026-08-02

### Added

- Initial release. Illumio Core (PCE) REST API v2 client (`lib/illumioApi.ts`)
  with HTTP Basic auth (API key + secret), a self-signed-tolerant `node:https`
  transport gated by the `verify_tls` setting, and org-scoped path helpers.
- **Labels** configuration type — manage Illumio Core labels (key/value policy
  objects under the `role` / `app` / `env` / `loc` built-in dimensions, or a
  custom dimension already created in the PCE) as code, with the full pipeline
  handler set: validate, deploy, rollback, drift detection, health check and
  status. Labels are matched by their **(key, value) pair** — the PCE's own
  identity for a label, since `key` is immutable after create — and created
  where missing; optional `external_data_set` / `external_data_reference`
  integration metadata is synced on labels that already exist. Reconcile only
  deletes labels this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared
  `<ConnectionsManager>` configured for the API key + secret credential and the
  `illumio-pce` deploy target.
- Connection test (`handlers/testConnection.ts`) verifying the PCE host/port/
  organization ID settings and the API key credential with a single
  `GET /orgs/{org_id}/labels?max_results=1`.

### Deferred

- Security policy (rule sets, rules, services, IP lists, enforcement
  boundaries) — the PCE's draft-then-provision model needs its own pipeline
  shape and is planned for a follow-up release.
- Custom label dimensions (`label_dimensions` API, PCE 22.5+) — not yet
  managed; `key` must reference an existing dimension.
