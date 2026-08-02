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
| **Service Objects** (`service-objects`) | Objects | TCP/UDP service objects | `show-services-tcp` / `show-services-udp`, `add-service-{tcp,udp}`, `set-service-{tcp,udp}`, `delete-service-{tcp,udp}` |
| **Access Rules** (`access-rules`) | Policy | Access-control (firewall) rules | `show-access-rulebase`, `add-access-rule`, `set-access-rule`, `delete-access-rule` |

All four target a `checkpoint-management` component and reconcile by
**name** (access rules: name **within** their declared layer + package).

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

### Access rules — the rulebase headline

The most involved config type, because a rulebase is ordered and a rule
references other objects (and other rules) by name.

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

## Authentication

Either of:

- **Username + password** — a Check Point administrator account. Store the
  username in the credential **Username** field and the password in
  **Password**.
- **API key** — SmartConsole **Object Explorer → New → API Key** (or
  `mgmt_cli add api-key`). Store it in the credential **API token** field.
  When present, the API key is used instead of username/password.

The administrator (or the API key's owning admin) needs a permission profile
that can read and write network objects, service objects and the target
access layer(s).

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

Access layer and policy package are **per-item canvas fields** on
`access-rules` (not global settings), so one canvas can manage rules across
several layers/packages.

## References

- [Check Point Management API Reference](https://sc1.checkpoint.com/documents/latest/APIs/) — session model, object/rule command reference. (The rendered reference is a client-side app WebFetch cannot execute; the sources below encode the identical, machine-verifiable contract.)
- [cp_mgmt_api_python_sdk](https://github.com/CheckPointSW/cp_mgmt_api_python_sdk) — Check Point's own Management API SDK; verified the login/`X-chkp-sid`/publish/discard/logout mechanics, the HTTP-200-only success rule, and the unversioned-by-default `/web_api/<command>` URL construction.
- [CheckPointAnsibleMgmtCollection](https://github.com/CheckPointSW/CheckPointAnsibleMgmtCollection) — `cp_mgmt_host[_facts]`, `cp_mgmt_network[_facts]`, `cp_mgmt_service_tcp[_facts]`, `cp_mgmt_service_udp[_facts]`, `cp_mgmt_access_rule[_facts]` modules; verified each object's documented parameters and the `show-services-tcp` / `show-services-udp` plural list command names.
- [terraform-provider-checkpoint](https://github.com/CheckPointSW/terraform-provider-checkpoint) — `resource_checkpoint_management_host.go`, `_network.go`, `_service_tcp.go`, `_service_udp.go`, `_access_rule.go`, and `data_source_checkpoint_management_access_rulebase.go` — read at the Go source level to verify exact payload/response field names (`ipv4-address`, `mask-length4`, `source-port`, `new-position`, the `rulebase[]` / `objects-dictionary[]` / `total`/`from`/`to` response envelope) and the `position` payload shapes (`"top"` / `"bottom"` bare strings vs `{ above: name }` / `{ below: name }` objects).

### Not modeled (flagged, not faked)

- **Hosts/networks:** group membership, NAT settings, host-servers
  (DNS/mail/web authentication roles) and multi-interface hosts are real
  properties but were dropped to keep these objects genuinely self-contained
  (no dependency on a group or a gateway to install NAT on). The exact
  enumerated list of valid `color` values could not be verified against a
  live server, so `color` is free-text, passed straight through — Check
  Point's own response is the source of truth if a value is rejected.
- **Services:** `keep-connections-open-after-policy-installation`,
  `session-timeout`, `match-for-any`, `aggressive-aging` (TCP/UDP) and
  `accept-replies` (UDP) are real, verified fields not yet modeled.
- **Access rules:** rules inside a named Section, the `User Auth` /
  `Client Auth` / `Apply Layer` actions, `vpn`/`time`/`content`/
  `custom-fields`/`user-check` matching, and position rollback (see above)
  are out of scope for this version.

## Development

```
cd apps/checkpoint
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs checkpoint        # run handler tests
node ../../scripts/validate-app.mjs apps/checkpoint # validate against the app contract
```
