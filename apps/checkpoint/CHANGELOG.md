# Changelog

All notable changes to the Check Point app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-08-03

Exhausts the config-as-code write surface for object management and adds a
second ordered rulebase (NAT), bringing this app to 11 configuration types.

### Added
- **Address ranges (`address-ranges`).** `add-address-range` /
  `set-address-range` / `delete-address-range` against `show-address-ranges`;
  identity by name. Each range declares a complete IPv4 and/or IPv6
  first/last endpoint pair; validation rejects a backwards IPv4 range.
- **Network groups (`network-groups`).** `add-group` / `set-group` /
  `delete-group` against `show-groups`; identity by name. Members (any
  object type, resolved by Check Point) are declared as a plain list —
  `set-group` always sends the FULL declared member list, so removing a name
  from the canvas removes that member from the live group.
- **Security zones (`security-zones`).** `add-security-zone` /
  `set-security-zone` / `delete-security-zone` against
  `show-security-zones`; identity by name. No fields beyond identity,
  comments, color and tags — a zone is a pure reference point (see Coverage
  for what points to it that this app does not manage).
- **Service groups (`service-groups`).** `add-service-group` /
  `set-service-group` / `delete-service-group` against
  `show-service-groups`; identity by name; same full-member-list update
  semantics as network groups.
- **Application sites (`application-sites`).** `add-application-site` /
  `set-application-site` / `delete-application-site` against
  `show-application-sites`; identity by name. Matches traffic by URL/domain
  pattern (wildcard glob or regular expression) plus an optional primary
  category; application-signature-based matching is not modeled (flagged).
- **Tags (`tags`).** `add-tag` / `set-tag` / `delete-tag` against
  `show-tags`; identity by name; comments/color only (a tag has no `tags`
  field of its own).
- **NAT rules (`nat-rules`) — a second ordered rulebase.** `add-nat-rule` /
  `set-nat-rule` / `delete-nat-rule` against `show-nat-rulebase`, sharing
  `access-rules`' position model (`top`/`bottom`/`above`/`below`,
  canvas-declaration-order application, position re-asserted on update,
  rollback restores fields but not position) via the newly shared
  `buildPositionPayload`/`RULE_POSITIONS` in `checkpointShared.ts`. Two
  differences from access rules, both verified against the Terraform
  provider source: NAT rulebases are **per-package** (no `layer` concept —
  identity is name within `package`, requires management version R81+), and
  `original-*`/`translated-*` are **single object names**, not arrays (blank
  original → `"Any"`, blank translated → `"Original"`, both re-asserted on
  every deploy). **Automatic NAT rules** (`auto-generated: true`, derived
  from an object's own `nat-settings`) are filtered out at list time and are
  never matched, updated, or deleted — even by a same-named declared rule.
- **`group` on every configuration type** — added retroactively to
  `network-hosts`/`network-objects`/`service-objects` ("Objects") and
  `access-rules` ("Policy") from 0.1.0/0.2.0, which shipped without it.
- **Shared `checkpointGetStatus`.** Every config type's `getStatus.ts` was
  byte-for-byte identical (deployment + component status via the platform
  data API only); factored into `config-types/lib/checkpointShared.ts` and
  reused by all 11 config types instead of being duplicated per type.
- **README Coverage section.** A complete map of the Check Point Management
  API's configuration-as-code surface: every config type this app manages,
  and every remaining surface (gateways/clusters/VPN communities that need
  topology, Threat Prevention/HTTPS-Inspection/Desktop/QoS rulebases,
  identity/user/administrator management, policy installation and other
  imperative actions, and rulebase Sections) intentionally excluded, with
  the reasoning for each.

### References (new this release)
- `github.com/CheckPointSW/terraform-provider-checkpoint` —
  `resource_checkpoint_management_{address_range,group,security_zone,
  service_group,application_site,tag,nat_rule}.go` and
  `data_source_checkpoint_management_nat_rulebase.go` — verified exact
  payload/response field names (`ipv4-address-first`, `auto-generated`, the
  `nat-rulebase` response envelope identified by `package`) and confirmed
  the NAT `position`/`new-position` payload shape is identical to access
  rules'.
- `github.com/CheckPointSW/CheckPointAnsibleMgmtCollection` —
  `cp_mgmt_address_range[_facts].py`, `cp_mgmt_group[_facts].py`,
  `cp_mgmt_security_zone[_facts].py`, `cp_mgmt_service_group[_facts].py`,
  `cp_mgmt_application_site[_facts].py`, `cp_mgmt_tag[_facts].py`,
  `cp_mgmt_nat_rule[_facts].py` — verified documented parameters, each
  object's primary identifier, and the `show-groups` / `show-security-zones`
  / `show-service-groups` / `show-tags` plural list command names.

## 0.2.0 — 2026-08-02

### Added
- **Network objects (`network-objects`).** Manage Check Point network (subnet)
  objects as code through `add-network` / `set-network` / `delete-network`,
  reconciled by name against `show-networks`. Each network declares an IPv4
  and/or IPv6 subnet in CIDR form (split into the API's separate
  `subnet4`/`mask-length4` and `subnet6`/`mask-length6` fields), plus
  comments/color/tags. Same create/update/remove reconciliation and full
  handler set as `network-hosts`.
- **Service objects (`service-objects`).** Manage Check Point TCP and UDP
  service objects as code through `add-service-tcp` / `add-service-udp` (and
  their `set-`/`delete-` counterparts), reconciled by name WITHIN the
  declared protocol's namespace — TCP and UDP are entirely separate object
  families with their own commands and their own `show-services-tcp` /
  `show-services-udp` listings. Each service declares a protocol, a port
  (single, range, or comma list), an optional source port, plus
  comments/color/tags.
- **Access rules (`access-rules`) — the rulebase headline.** Manage Check
  Point access-control rules as code through `add-access-rule` /
  `set-access-rule` / `delete-access-rule` against `show-access-rulebase`,
  reconciled by rule name WITHIN its declared access layer + policy package
  (a name is unique per layer+package, not globally — different layers
  legitimately reuse rule names). Each rule declares action, track,
  enabled state, source/destination/service (object names, or empty for
  "Any"), an install-on target, and a position (top / bottom / above /
  below another named rule or section).
  - **Ordering model:** items are applied in canvas declaration order (top to
    bottom) because an above/below position references another rule/section
    BY NAME, which must already exist — either pre-existing or an earlier
    item in the same deploy. This config type does not attempt automatic
    dependency resolution/topological sorting; declare an anchor rule before
    anything that positions itself relative to it.
  - **Publish semantics:** exactly like the other three config types, one
    deploy is one Management API session — every add/set/delete for every
    declared rule happens before a single `publish`, and any failure
    `discard`s the whole session instead of leaving a partially-applied
    rulebase.
  - **Self-healing position:** an existing rule's position is re-asserted
    (`new-position`) on every deploy, so a manual reorder in SmartConsole is
    corrected back to the declared position on the next deploy — not just
    its field values.
  - **Flagged assumption — rollback does not restore position.**
    `show-access-rulebase` returns a rule's `rule-number` (a live, volatile
    ordinal — not a stable "restore-to" anchor other admins' unrelated
    changes don't shift), not a "prior sibling" identifier. Rollback
    therefore restores a rule's field values (action/track/matching/
    install-on/comments) but intentionally leaves its position wherever the
    subsequent deploys left it.
  - **Flagged/dropped scope.** Managing rules filed under a named Section
    header is out of scope for this version — only flat, top-level rulebase
    entries are read, matched, and reconciled; a section header (and
    anything nested inside one) is skipped entirely, never modified. `action`
    values that need extra configuration this config type does not model
    (`User Auth`, `Client Auth`, `Apply Layer`) are not offered. The literal
    default Check Point substitutes for an unset `install-on`
    ("Policy Targets" in SmartConsole) was not independently verified this
    session, so an undeclared `installOn` is never force-written — the
    rule's existing install target (or Check Point's own default) is left
    alone rather than guessed.
- **`group` on every configuration type** (`network-hosts`/`network-objects`/
  `service-objects`: "Objects"; `access-rules`: "Policy") for the
  Configuration Canvas sidebar grouping — added retroactively to
  `network-hosts` as well.
- **Shared validation module (`config-types/lib/checkpointShared.ts`).**
  `strList`, `objectKey`, `isValidIpv4`, `isValidIpv6`, `liveTagNames`,
  `sameStringSet` factored out of `network-hosts/validate.ts` and reused by
  all four config types, instead of being duplicated or cross-imported
  between sibling config-type folders.

### References (new this release)
- `github.com/CheckPointSW/terraform-provider-checkpoint` —
  `resource_checkpoint_management_network.go`,
  `resource_checkpoint_management_service_tcp.go` /
  `_service_udp.go`, `resource_checkpoint_management_access_rule.go`,
  `data_source_checkpoint_management_access_rulebase.go` — verified exact
  payload/response field names (including the `show-access-rulebase`
  response envelope: `rulebase[]`, `objects-dictionary[]`, `total`/`from`/`to`)
  and the `position`/`new-position` payload shapes.
- `github.com/CheckPointSW/CheckPointAnsibleMgmtCollection` —
  `cp_mgmt_network[_facts].py`, `cp_mgmt_service_tcp[_facts].py`,
  `cp_mgmt_service_udp[_facts].py`, `cp_mgmt_access_rule[_facts].py` —
  verified documented parameters and the `show-services-tcp` /
  `show-services-udp` plural list command names.

## 0.1.0 — 2026-08-02

### Added
- **Network hosts (`network-hosts`).** Manage Check Point Management API host
  objects as code through `add-host` / `set-host` / `delete-host`, reconciled
  by object name against `show-hosts`. Missing hosts are created, existing
  hosts are updated to the declared spec (IPv4/IPv6 address, comments, color,
  tags), and hosts this app previously created but no longer declares are
  removed. Ships the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus).
- **Session lifecycle client (`lib/checkpointApi.ts`).** A from-scratch
  Management API client implementing the login → act → publish/discard →
  logout unit of work: `POST /web_api/login` with either a username/password
  or an API key, `X-chkp-sid` on every subsequent call, `publish` on success,
  `discard` on any error, `logout` always. Talks to the Management Server over
  `node:https` with a dedicated `https.Agent` so the "Verify TLS certificate"
  setting genuinely controls whether a self-signed management certificate is
  accepted (off by default, matching the common on-prem default).
- **Connection test.** Login → a bounded `show-hosts` read (`limit: 1`) →
  logout — verifies the host, credential and Management API session model
  without making or publishing any change.
