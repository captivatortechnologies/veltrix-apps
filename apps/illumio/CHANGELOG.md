# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.3.0 — 2026-08-04

### Added

Four new configuration types, exhausting the PCE's declarative write surface
for security policy and VEN onboarding (see README.md's **Coverage** section
for the full managed-vs-excluded inventory):

- **Label Groups** configuration type — named sets of same-dimension labels
  (`/orgs/{org_id}/sec_policy/draft/label_groups`), name-keyed. A group's
  `key` names the dimension every member label must share (per the Terraform
  schema's own field description); member labels are resolved by key+value
  to hrefs and **fail closed** on anything unresolved. Draft → provision,
  same as IP Lists/Services/Rulesets. Sub-groups (a group containing other
  groups) are not supported.
- **Enforcement Boundaries** configuration type — deny-by-default rules
  (`/orgs/{org_id}/sec_policy/draft/enforcement_boundaries`), name-keyed.
  Unlike a ruleset, a boundary has no scope wrapper: providers, consumers and
  ingress services sit directly on it, each referencing a label, IP list or
  "All Workloads" (the PCE actor `ams` — confirmed as the *only* allowed
  actor value here, stricter than a security rule's consumer side) by name.
  Fails closed on any unresolved reference. Draft → provision.
- **Virtual Services** configuration type — a named port group (or a
  reference to an existing Service) workloads can be classified under
  (`/orgs/{org_id}/sec_policy/draft/virtual_services`), name-keyed. Exactly
  one of an existing Service (by name) or inline service ports (TCP/UDP
  only — narrower than the Services type's proto range) is required,
  mirroring the PCE's own `ExactlyOneOf` constraint. Optional label refs and
  IP overrides. Fails closed on unresolved service/label references. Draft →
  provision.
- **Pairing Profiles** configuration type — VEN onboarding templates
  (`/orgs/{org_id}/pairing_profiles`): starting labels, enforcement mode,
  visibility level, and pairing-key use/lifespan limits (`"unlimited"` or an
  integer, matching the PCE's own field semantics — an unparseable/"unlimited"
  value is simply omitted from the request body, telling the PCE to use its
  own default). **Not draft-then-provision** — confirmed no `StoreHref` call
  anywhere in the Terraform provider's pairing-profile resource, unlike every
  other resource in this release; writes take effect immediately, the same
  posture as Labels. Fails closed on unresolved label references.
- `group:` added to all four — Label Groups and Virtual Services under
  **Policy Objects**, Enforcement Boundaries under **Security Policy**,
  Pairing Profiles under **Workloads**.
- README.md **Coverage** section: every Illumio config surface this app
  manages vs. intentionally excludes, and why (Workloads/VENs are
  agent-reported inventory not declarative state; Virtual Servers need
  SLB/NEN integration; Pairing Keys are short-lived credential material;
  custom Label Dimensions are a PCE-version-gated tenant schema; Firewall
  Settings and other singletons aren't safely modeled as canvas items).

### Deferred / out of scope (flagged, not faked)

- Label group sub-groups (nested label groups).
- Enforcement boundary actors beyond label / IP list / "All Workloads"
  (label groups as boundary actors are not supported).
- Virtual service `service_addresses` (DNS/load-balancer-oriented
  addressing) and Windows service definitions.
- Pairing profile lock-flag and log-traffic drift comparison (drift focuses
  on enabled, enforcement mode, key limits, labels and visibility level).

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