# Check Point (Veltrix app)

Manage [Check Point](https://www.checkpoint.com) Security Management Server
configuration as code through the **Check Point Management API**
(`web_api`), driven by the Veltrix Security-as-Code pipeline (validate →
deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | Sidebar group | Check Point object | Management API commands |
| --- | --- | --- | --- |
| **Network Hosts** (`network-hosts`) | Objects | Host objects | `show-hosts` / `show-host`, `add-host`, `set-host`, `delete-host` |
| **Network Objects** (`network-objects`) | Objects | Network (subnet) objects | `show-networks` / `show-network`, `add-network`, `set-network`, `delete-network` |
| **Address Ranges** (`address-ranges`) | Objects | Address-range objects | `show-address-ranges` / `show-address-range`, `add-address-range`, `set-address-range`, `delete-address-range` |
| **Network Groups** (`network-groups`) | Objects | Group objects | `show-groups` / `show-group`, `add-group`, `set-group`, `delete-group` |
| **Security Zones** (`security-zones`) | Objects | Security-zone objects | `show-security-zones` / `show-security-zone`, `add-security-zone`, `set-security-zone`, `delete-security-zone` |
| **Service Objects** (`service-objects`) | Objects | TCP/UDP service objects | `show-services-tcp` / `show-services-udp`, `add-service-{tcp,udp}`, `set-service-{tcp,udp}`, `delete-service-{tcp,udp}` |
| **Service Groups** (`service-groups`) | Objects | Service-group objects | `show-service-groups` / `show-service-group`, `add-service-group`, `set-service-group`, `delete-service-group` |
| **Application Sites** (`application-sites`) | Objects | Custom application-site objects | `show-application-sites` / `show-application-site`, `add-application-site`, `set-application-site`, `delete-application-site` |
| **Tags** (`tags`) | Objects | Tag objects | `show-tags` / `show-tag`, `add-tag`, `set-tag`, `delete-tag` |
| **Access Rules** (`access-rules`) | Policy | Access-control (firewall) rules | `show-access-rulebase`, `add-access-rule`, `set-access-rule`, `delete-access-rule` |
| **NAT Rules** (`nat-rules`) | Policy | Manual NAT rules | `show-nat-rulebase`, `add-nat-rule`, `set-nat-rule`, `delete-nat-rule` |

All eleven target a `checkpoint-management` component and reconcile by
**name** (rulebase types: name **within** their declared layer/package or
package).

## Session model — login, publish, discard, logout

Every Management API write is a **session**: log in, make one or more
changes, then either **publish** them together or **discard** the whole
session on any error. This app treats one deploy/rollback as exactly one
session — regardless of config type — so a partial failure never leaves a
half-applied configuration published:

1. `POST /web_api/login` — `{ user, password }` or `{ api-key }` → `{ sid }`
2. Every subsequent call carries `X-chkp-sid: <sid>`
3. One `add-*` / `set-*` / `delete-*` call per reconciled object
4. On success: `POST /web_api/publish` commits every change together
5. On any error: `POST /web_api/discard` throws the whole session away
6. `POST /web_api/logout` always ends the session

Publishing here does **not** install a security policy on a gateway — it only
commits object changes to the management database, the same effect as
clicking **Publish** in SmartConsole.

### Network hosts

Deploy lists the management database (`show-hosts`, paginated 500/page),
matches declared items by `name`, and reconciles:

- missing hosts → `add-host`
- existing hosts → `set-host` (always applied, so drift in fields the canvas
  doesn't manage is left alone but every managed field is set to the declared
  value)
- hosts this app created in a **prior successful deploy** but no longer
  declares → `delete-host`

Each host declares an IPv4 and/or IPv6 address (at least one required),
optional comments, an optional color, and optional tags. Rollback restores
each updated host's prior managed fields and removes hosts this app created,
then publishes that reversal as its own session.

### Network objects

Identical reconciliation shape to network hosts, against `show-networks` /
`add-network` / `set-network` / `delete-network`. Each network declares an
IPv4 and/or IPv6 subnet in CIDR form (e.g. `10.0.100.0/24`), which this app
splits into the API's separate `subnet4` + `mask-length4` (and/or `subnet6` +
`mask-length6`) fields — the network object API does not accept a combined
CIDR string directly.

### Address ranges

Identical reconciliation shape again, against `show-address-ranges` /
`add-address-range` / `set-address-range` / `delete-address-range`. Each
range declares a complete IPv4 (`ipv4-address-first` / `ipv4-address-last`)
and/or IPv6 first/last endpoint pair. Validation rejects a backwards IPv4
range (first numerically after last); the equivalent IPv6 numeric comparison
is not implemented (endpoints are still validated as well-formed addresses).

### Network groups

Group objects via `show-groups` / `add-group` / `set-group` /
`delete-group`. Members (hosts, networks, address ranges, other groups —
any object type; Check Point resolves each declared name) are declared as a
plain list. **Update always sends the full declared member list** — unlike
the other object types' create-or-update-in-place shape, an update here
fully replaces the group's membership, so removing a name from the canvas
removes that member from the live group on the next deploy. An empty-member
group is valid.

### Security zones

The simplest object in this app: `show-security-zones` / `add-security-zone`
/ `set-security-zone` / `delete-security-zone`, with no fields beyond
identity, comments, color and tags. A security zone is purely a reference
point — interface anti-spoofing settings and zone-based rule matching
("source zone" / "destination zone") point to it, and neither of those
referencing surfaces is managed by this app (see Coverage).

### Service objects

TCP and UDP services are **entirely separate object families** in the
Management API — different add/set/delete commands, different list commands
(`show-services-tcp` vs `show-services-udp`), and (in principle) independent
namespaces. This config type models both through one canvas with a
**Protocol** field that selects which command family a given item uses.
Reconciliation is otherwise the same shape as hosts/networks, matched by name
**within** the declared protocol. Each service declares a port — a single
port, a range (`8000-8010`), or a comma list (`80,443,8080-8090`) — and an
optional source port in the same format.

### Service groups

The service-object equivalent of network groups: `show-service-groups` /
`add-service-group` / `set-service-group` / `delete-service-group`, member
service names declared as a plain list, update sends the full list, empty
groups are valid.

### Application sites

Custom URL-defined applications via `show-application-sites` /
`add-application-site` / `set-application-site` / `delete-application-site`.
Each site declares one or more URL/domain patterns (matched as wildcard glob
by default, or as a regular expression when **Patterns Are Regular
Expressions** is enabled), an optional primary-category reference, a
description, comments, color and tags. This config type identifies traffic
by URL/domain pattern **only** — application-signature-based matching (the
binary signature SmartConsole captures from live traffic) is a real,
verified field this config type does not model (see Coverage).

### Tags

`show-tags` / `add-tag` / `set-tag` / `delete-tag`, with only comments and
color beyond identity — a tag object has no `tags` field of its own. Most
other config types in this app can implicitly create a tag by naming it in
their own `tags` field (Check Point auto-creates a referenced tag that
doesn't yet exist); this config type exists for declaring a tag's own
color/comments explicitly, or pre-creating a tag no object references yet.

### Access rules — a rulebase headline

The most involved object config type, because a rulebase is ordered and a
rule references other objects (and other rules) by name.

**Identity and scope.** A rule's identity is its `name`, matched **within**
its declared access layer + policy package — not globally, since different
layers legitimately reuse rule names (e.g. every layer might have a
"Cleanup"). This config type manages **flat, top-level rules only**: a
`show-access-rulebase` entry with `type: "access-section"` (a named Section
header in SmartConsole) is skipped entirely, and rules filed inside one are
never read, matched, or touched.

**Ordering — how position works and its limits.**

- Each rule declares a `position`: `top` / `bottom` (absolute), or
  `above` / `below` a named rule or section (`positionAnchor`) — exactly the
  four values `add-access-rule`'s `position` (and `set-access-rule`'s
  `new-position`) accept.
- Items are applied in **canvas declaration order** (top to bottom). An
  above/below anchor must already exist — either pre-existing in the
  rulebase, or an **earlier** item in the same deploy. This config type does
  **not** attempt automatic dependency resolution or topological sorting: if
  a rule positions itself relative to a rule declared later in the same
  canvas, the deploy fails with Check Point's own "object not found" for that
  add/set call (and the whole session is discarded). **Flagged assumption:**
  declare an anchor rule before anything that positions itself above/below
  it.
- On every deploy, an **existing** rule's position is re-asserted via
  `new-position` — not just its field values — so a manual reorder in
  SmartConsole is corrected back on the next deploy.
- **Rollback does not restore position.** `show-access-rulebase` returns a
  rule's `rule-number`, a live/volatile ordinal that shifts as anyone adds or
  removes rules elsewhere in the layer — it is not a stable "restore to"
  anchor. Rollback therefore restores a rule's field values
  (action/track/enabled/source/destination/service/install-on/comments) but
  intentionally leaves its position wherever subsequent deploys left it.
  **Flagged limitation**, not silently faked.

**Matching fields.** `source` / `destination` / `service` are object names;
an empty list is sent as the literal member `["Any"]` on **every** deploy
(create and update) rather than omitted — `set-access-rule` only touches
fields it's given, so omitting an empty list would never heal a rule a human
had manually narrowed back open to the declared "Any".

**Action / track.** `action` accepts `Accept` / `Drop` / `Reject` / `Ask` /
`Inform`. `User Auth`, `Client Auth` and `Apply Layer` are **not modeled** —
they need identity-awareness settings or an inline layer this config type
does not manage. `track` accepts `None` / `Log` / `Alert` (only the
track-type; per-session/accounting/alert-detail sub-settings are not
modeled).

**Install-on.** Only sent when the canvas declares at least one gateway/
cluster name. **Flagged assumption:** the literal token Check Point
substitutes for an unset `install-on` (`"Policy Targets"` in SmartConsole)
was not independently re-verified against a live server this session, so an
undeclared `installOn` is never force-written on update — the rule's
existing install target (or Check Point's own default) is left alone rather
than guessed.

### NAT rules — the same rulebase model, per package

Manual NAT rules via `add-nat-rule` / `set-nat-rule` / `delete-nat-rule`
against `show-nat-rulebase`, sharing the access-rules ordering model and its
documented limitations (declaration-order application, position
re-asserted on update, rollback restores fields but not position). Two
differences from access rules:

- **Per-package, not per-layer.** A NAT rulebase belongs directly to a
  policy `package` — there is no `layer` concept for NAT. A rule's identity
  is therefore its `name` within its `package`. Naming a NAT rule requires
  Check Point management version **R81 or later** (verified:
  `cp_mgmt_nat_rule.py`, "Rule name. Available from R81 management
  version.").
- **Original/translated fields are single object names, not arrays.**
  `original-source` / `original-destination` / `original-service` and
  `translated-source` / `translated-destination` / `translated-service` are
  each ONE object name (verified against the Terraform schema: `Optional
  string`, not a set). A blank original field is sent as `"Any"`; a blank
  translated field is sent as `"Original"` (no translation) — both
  re-asserted on every deploy for the same self-healing reason as access
  rules' `["Any"]`.
- **Automatic NAT rules are never touched.** A NAT rulebase mixes
  user-created ("manual") rules with rules Check Point generates from an
  object's own NAT settings (`nat-settings.auto-rule` on a host/network/
  address-range). `show-nat-rulebase` marks these `auto-generated: true`;
  this config type filters them out entirely at list time, so they are never
  matched, updated, deleted, or reconciled-away — even if a declared rule
  happens to share a name with one.
- `method` is `hide` or `static` (verified field; this app defaults new
  rules to `hide` as a UX choice, not a re-verified Check Point default).

## Authentication

Either of:

- **Username + password** — a Check Point administrator account. Store the
  username in the credential **Username** field and the password in
  **Password**.
- **API key** — SmartConsole **Object Explorer → New → API Key** (or
  `mgmt_cli add api-key`). Store it in the credential **API token** field.
  When present, the API key is used instead of username/password.

The administrator (or the API key's owning admin) needs a permission profile
that can read and write network objects, service objects, and the target
access layer(s) / policy package(s).

## Component

Register a `checkpoint-management` component whose **hostname** is the same
Management Server address SmartConsole connects to. Management API requests
go to `https://<host>:<port>/web_api/<command>` (unversioned by default).

## TLS

An on-prem Security Management Server commonly ships a **self-signed
certificate** for `web_api` / SmartConsole. This app talks to it over
`node:https` with its own `https.Agent`, independent of the platform's global
`fetch` — so **Verify TLS certificate** genuinely controls whether the
certificate is checked (off by default). Turn it on once a CA-signed
certificate is installed.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `port` | `443` | Management API HTTPS port. |
| `verify_tls` | `false` | Enforce a valid TLS certificate on the Management Server. |
| `domain` | _(none)_ | Multi-Domain Security Management only — the Domain Management Server / CMA to log into. |
| `request_timeout_seconds` | `30` | Per-request timeout for Management API calls. |

Access layer / policy package are **per-item canvas fields** on
`access-rules` / `nat-rules` (not global settings), so one canvas can manage
rules across several layers/packages.

## References

- [Check Point Management API Reference](https://sc1.checkpoint.com/documents/latest/APIs/) — session model, object/rule command reference. (The rendered reference is a client-side app WebFetch cannot execute; the sources below encode the identical, machine-verifiable contract.)
- [cp_mgmt_api_python_sdk](https://github.com/CheckPointSW/cp_mgmt_api_python_sdk) — Check Point's own Management API SDK; verified the login/`X-chkp-sid`/publish/discard/logout mechanics, the HTTP-200-only success rule, and the unversioned-by-default `/web_api/<command>` URL construction.
- [CheckPointAnsibleMgmtCollection](https://github.com/CheckPointSW/CheckPointAnsibleMgmtCollection) — `cp_mgmt_host[_facts]`, `cp_mgmt_network[_facts]`, `cp_mgmt_address_range[_facts]`, `cp_mgmt_group[_facts]`, `cp_mgmt_security_zone[_facts]`, `cp_mgmt_service_tcp[_facts]`, `cp_mgmt_service_udp[_facts]`, `cp_mgmt_service_group[_facts]`, `cp_mgmt_application_site[_facts]`, `cp_mgmt_tag[_facts]`, `cp_mgmt_access_rule[_facts]`, `cp_mgmt_nat_rule[_facts]` modules — verified each object's documented parameters, its primary identifier, and the `show-*` plural list command names (e.g. `show-services-tcp`, `show-security-zones`).
- [terraform-provider-checkpoint](https://github.com/CheckPointSW/terraform-provider-checkpoint) — `resource_checkpoint_management_{host,network,address_range,group,security_zone,service_tcp,service_udp,service_group,application_site,tag,access_rule,nat_rule}.go` and `data_source_checkpoint_management_{access_rulebase,nat_rulebase}.go` — read at the Go source level to verify exact payload/response field names (`ipv4-address`, `mask-length4`, `ipv4-address-first`, `source-port`, `new-position`, the `rulebase[]` / `objects-dictionary[]` / `total`/`from`/`to` response envelope, `auto-generated`) and the `position` payload shapes (`"top"` / `"bottom"` bare strings vs `{ above: name }` / `{ below: name }` objects, identical between access rules and NAT rules).

### Not modeled (flagged, not faked)

- **Hosts/networks/address ranges:** group membership, NAT settings,
  host-servers (DNS/mail/web authentication roles) and multi-interface hosts
  are real properties but were dropped to keep these objects genuinely
  self-contained (no dependency on a group or a gateway to install NAT on).
  The exact enumerated list of valid `color` values could not be verified
  against a live server, so `color` is free-text, passed straight through —
  Check Point's own response is the source of truth if a value is rejected.
- **Services:** `keep-connections-open-after-policy-installation`,
  `session-timeout`, `match-for-any`, `aggressive-aging` (TCP/UDP) and
  `accept-replies` (UDP) are real, verified fields not yet modeled.
- **Application sites:** application-signature-based matching (the binary
  signature SmartConsole captures from live traffic), `additional-categories`,
  and application-category/group management (`cp_mgmt_application_site_category`
  / `_group`) are separate, more involved surfaces not modeled here.
- **Access rules:** rules inside a named Section, the `User Auth` /
  `Client Auth` / `Apply Layer` actions, `vpn`/`time`/`content`/
  `custom-fields`/`user-check` matching, and position rollback (see above)
  are out of scope for this version.
- **NAT rules:** the same Section-nesting and position-rollback exclusions as
  access rules, plus per-object `nat-settings` (the auto-generated side of
  NAT, editable on the host/network/address-range object itself, not through
  this rulebase).

## Coverage

What of the Check Point Management API's configuration-as-code surface this
app manages, versus what is intentionally excluded and why — audited against
the Check Point Management API reference and Check Point's own maintained
Ansible collection and Terraform provider source (see References).

### Managed

| Configuration type | Management API commands |
| --- | --- |
| Network hosts | `show-hosts`/`show-host`, `add-host`, `set-host`, `delete-host` |
| Network objects | `show-networks`/`show-network`, `add-network`, `set-network`, `delete-network` |
| Address ranges | `show-address-ranges`/`show-address-range`, `add-address-range`, `set-address-range`, `delete-address-range` |
| Network groups | `show-groups`/`show-group`, `add-group`, `set-group`, `delete-group` |
| Security zones | `show-security-zones`/`show-security-zone`, `add-security-zone`, `set-security-zone`, `delete-security-zone` |
| TCP/UDP services | `show-services-{tcp,udp}`, `add-`/`set-`/`delete-service-{tcp,udp}` |
| Service groups | `show-service-groups`/`show-service-group`, `add-service-group`, `set-service-group`, `delete-service-group` |
| Custom application sites | `show-application-sites`/`show-application-site`, `add-application-site`, `set-application-site`, `delete-application-site` |
| Tags | `show-tags`/`show-tag`, `add-tag`, `set-tag`, `delete-tag` |
| Access rules | `show-access-rulebase`, `add-access-rule`, `set-access-rule`, `delete-access-rule` |
| Manual NAT rules | `show-nat-rulebase`, `add-nat-rule`, `set-nat-rule`, `delete-nat-rule` (automatic rules are read-only, never touched) |

Every write happens inside ONE login session; publish commits it atomically,
any failure discards the whole session (see Session model, above). Object
collections reconcile by name (network groups / service groups always
replace their full member list on update); rulebase types reconcile by name
within their layer/package (access rules) or package (NAT rules) and
re-assert their declared position on every deploy.

### Intentionally excluded

- **Gateways, clusters and VPN communities** — these carry topology
  (interfaces, anti-spoofing groups, cluster member roles, IKE/IPsec peer
  configuration) that is fundamentally different in shape from the flat
  name-keyed objects this app manages, and mutating them safely requires
  install/verify workflows this app does not perform. Managing them as a
  generic object type would be misleading, not merely incomplete.
- **Other object families** not yet built out: multicast addresses, dynamic
  (wildcard) objects, group-with-exclusion, time objects (used by access
  rules' `time` field), application categories/groups, DCE-RPC/other
  service protocols beyond TCP/UDP, data-type objects, and HTTPS-inspection
  objects. Each has its own schema and is a reasonable next config type, but
  was not included in this pass to keep each shipped type genuinely
  complete rather than partially modeled.
- **Threat Prevention, HTTPS Inspection, Desktop and QoS rulebases** are
  separate policy models from Access Control and NAT (different rule
  schemas, different `show-*-rulebase` commands) and are out of scope.
- **Identity Awareness, users and administrators** — user/user-group/
  identity-provider objects, administrator accounts, permission profiles,
  API keys and trusted-client management are a distinct
  security-administration surface (who can reach the Management Server at
  all), deliberately excluded from an app whose job is target-system
  configuration.
- **Policy installation and other imperative actions** —
  `install-policy`/`verify-policy`, revision restore/purge, import/export,
  `run-script`, and session/task/log/monitoring commands are one-off
  operations, not desired-state configuration; `publish` is used here only
  to commit this app's own session, never to trigger a policy push to a
  gateway.
- **Sections** (both access-rulebase and NAT-rulebase) — rules filed under a
  named Section header are not read, matched, or reconciled by any rulebase
  config type in this app (see the Access rules and NAT rules sections
  above); only flat, top-level rules are managed.

## Development

```
cd apps/checkpoint
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs checkpoint        # run handler tests
node ../../scripts/validate-app.mjs apps/checkpoint # validate against the app contract
```
