# OPNsense (Veltrix app)

Manage [OPNsense](https://opnsense.org) open-source firewall configuration as
code through its **REST API**, driven by the Veltrix Security-as-Code
pipeline (validate → deploy → health check → drift detect → rollback).

## What it manages

This app exhausts OPNsense's cleanly-writable config-as-code surface as of
v0.3.0 — see the **Coverage** section below for what was deliberately left
out, and why.

| Configuration type | Group | OPNsense object | API commands | Version floor | Reconciled by |
| --- | --- | --- | --- | --- | --- |
| **Firewall Aliases** (`firewall-aliases`) | Firewall | Firewall alias objects | `searchItem`, `addItem`, `setItem`, `delItem`, `reconfigure` (apply) | any | name |
| **Firewall Categories** (`firewall-categories`) | Firewall | Metadata tags | `searchItem`, `addItem`, `setItem`, `delItem` — no apply step | any | name |
| **Firewall Rules** (`firewall-rules`) | Firewall | pf filter rules | `searchRule`, `addRule`, `setRule`, `delRule`, `apply` | **OPNsense 24.1+** | canvas item id |
| **Source NAT** (`source-nat`) | NAT | Outbound NAT rules | `searchRule`, `addRule`, `setRule`, `delRule`, `apply` | **OPNsense 24.1+**, mode = Hybrid/Manual | canvas item id |
| **1:1 NAT** (`one-to-one-nat`) | NAT | BINAT/1:1 NAT rules | `searchRule`, `addRule`, `setRule`, `delRule`, `apply` | **OPNsense 24.1.9+** | canvas item id |
| **Unbound Host Overrides** (`unbound-host-overrides`) | Services | DNS Resolver host records | `searchHostOverride`, `addHostOverride`, `setHostOverride`, `delHostOverride`, `reconfigure` | any | (hostname, domain) |
| **Unbound Domain Overrides** (`unbound-domain-overrides`) | Services | DNS Resolver forward entries (`dots.dot`, type=forward) | `searchForward`, `addForward`, `setForward`, `delForward`, `reconfigure` | any | domain |
| **Traffic Shaper Pipes** (`traffic-shaper-pipes`) | Traffic Shaping | Bandwidth-cap pipes | `searchPipes`, `addPipe`, `setPipe`, `delPipe`, `reconfigure` | any | description |
| **Traffic Shaper Queues** (`traffic-shaper-queues`) | Traffic Shaping | Weighted queues on a pipe | `searchQueues`, `addQueue`, `setQueue`, `delQueue`, `reconfigure` | any | description |
| **Traffic Shaper Rules** (`traffic-shaper-rules`) | Traffic Shaping | Classifier rules | `searchRules`, `addRule`, `setRule`, `delRule`, `reconfigure` | any | canvas item id |
| **Static Routes** (`static-routes`) | Routing | Static routes | `searchroute`, `addroute`, `setroute`, `delroute`, `reconfigure` | any | network |

All eleven target an `opnsense-firewall` component. Config types with no
natural name field (Firewall Rules, Source NAT, 1:1 NAT, Traffic Shaper
Rules) reconcile by the **canvas item's own id** instead (see "Firewall
rules & source NAT" below for why).

## API basics

- **Base URL:** `https://<host>[:port]/api/<module>/<controller>/<command>[/<param>...]`
- **Auth:** HTTP Basic on every request — the API **key** in the username
  position, the API **secret** in the password position. Generate a pair per
  user under **System > Access > Users > &lt;user&gt; > API keys**; OPNsense
  stores only its hash, so a lost secret means generating a new pair.
- **Content:** every request/response body is JSON. A POST body is only
  parsed when the request carries `Content-Type: application/json` — a
  form-encoded or missing header is silently treated as "no body sent."

Reference: [docs.opnsense.org/development/api.html](https://docs.opnsense.org/development/api.html).

## Stage, then apply

OPNsense splits every configuration change into two steps, and this app
models that split explicitly rather than pretending it's one atomic call:

1. `addItem`/`setItem`/`delItem` (aliases, categories) or `addRule`/`setRule`/
   `delRule` (filter rules, source NAT) — each of these only **stages** the
   change into the pending configuration (`config.xml` in memory, then on
   disk). Nothing on the wire changes yet.
2. The **apply** step — different per resource, and NOT interchangeable in
   name, though several share the exact same backend command:
   - **Literal-`"ok"` contract** (`reconfigureModule()` in
     `lib/opnsenseCore.ts`): `POST /api/firewall/alias/reconfigure`
     (`AliasController::reconfigureAction`, runs `filter reload skip_alias` +
     `template reload OPNsense/Filter` + `filter refresh_aliases`),
     `POST /api/unbound/service/reconfigure` (the generic
     `ApiMutableServiceControllerBase::reconfigureAction`, which also STOPS
     THEN STARTS the Unbound resolver), `POST /api/trafficshaper/service/reconfigure`
     (a custom override: reloads the Shaper/IPFW templates then
     `shaper reload` + `ipfw reload`), and `POST /api/routes/routes/reconfigure`
     (`interface routes configure`) — all four return exactly
     `{"status":"ok"}` on success and something else (never a passthrough
     value) on failure.
   - **Lenient, passthrough contract** (`applyFilterModule()`):
     `POST /api/firewall/filter/apply`, `POST /api/firewall/source_nat/apply`
     and `POST /api/firewall/one_to_one/apply` all run `filter reload
     skip_alias` — a full pf ruleset reload — inherited unmodified from
     `FilterBaseController::applyAction()` (verified: `SourceNatController`
     and `OneToOneController` both extend it without overriding `apply`).
     **FLAGGED:** unlike the literal-"ok" group, the success value here is
     whatever that backend command prints (`configdRun`'s raw stdout), not a
     pinned literal — only `"error"` is a known failure value in the source
     read for this app. `applyFilterModule()` treats any other non-empty
     status as success and surfaces the raw value.
   - **Firewall categories have no apply step at all** — they're pure
     metadata with zero live pf effect (verified: no such action exists on
     `CategoryController`).

Every deploy or rollback that stages at least one change calls its resource's
own apply step exactly **once**, after every stage call, so the whole batch
takes effect together. Unlike a session-transactional API (this codebase's
Check Point app, for example), OPNsense has no "discard" for a partially
staged batch — if a stage call fails partway through a deploy, whatever was
staged *before* the failure remains staged (visible as pending changes on the
box) but apply never runs, so **nothing reaches the running firewall**. The
failed deploy's `rollbackData` still records everything staged up to that
point, so rollback can cleanly undo it.

### Firewall aliases

Deploy lists every configured alias (`searchItem`, which defaults to
returning ALL rows in one page), matches declared items by `name`, and
reconciles:

- missing aliases → `addItem`
- existing aliases → `setItem`, always sending every managed field (so
  clearing a field in the canvas genuinely clears it on OPNsense — `setItem`
  only overwrites the keys present in the body, it does not reset unset ones)
- aliases this app created in a **prior successful deploy** but no longer
  declares → `delItem` (blocked by OPNsense itself, surfaced as a deploy
  error, if another alias or firewall/NAT rule still references it by name)

Each alias declares a `type` (see the supported list below), one or more
`content` entries (validated per type — see `_shared.ts`), an optional
description, an enabled/disabled toggle, an optional IPv4/IPv6 protocol
filter, and two type-specific fields: `interface` (required for Dynamic IPv6
Host) and `updatefreq` (URL Table refresh cadence, in days).

**Supported types:** Host(s), Network(s), Port(s), URL (IPs), URL Table
(IPs), URL Table in JSON format (IPs), GeoIP, Network group, MAC address, BGP
ASN, Dynamic IPv6 Host.

**A field, not an array — everywhere.** OPNsense's model fields (`content`,
`proto`, ...) are set via a PHP `(string)` cast; sending a JSON array for one
of them doesn't get "joined" — `BaseModel::setNodes` throws outright
("Invalid input type for content: expected a single value"). `content` is
therefore always sent as ONE string with entries joined by `\n` (the same
separator OPNsense's own `AliasContentField` uses internally), and `proto` as
a comma-joined string — never a JSON array. See the doc comment on
`AliasBody` in `lib/opnsenseApi.ts`.

Rollback restores each updated alias's prior body (re-found by its current
name, not a possibly-stale captured uuid) and removes aliases this app
created, applying that reversal with its own `reconfigure` call.

### Firewall categories

Pure metadata tags — no live pf effect. Deploy lists every configured
category (`searchItem`), matches declared items by `name`, and reconciles the
same create/update/delete way as aliases, EXCEPT there is no apply step at
all (verified: no such action exists on `CategoryController`) — staging IS
the whole deploy. System-managed categories (`auto: "1"`, e.g. an
Anti-Lockout category some NAT versions auto-create) are never matched,
updated or deleted by this app. A category's `name` must not contain a comma
(`Category.xml`'s own field mask) since categories are stored as a
comma-separated list wherever a rule or alias references them.

### Firewall rules & source NAT

**Version floor:** both require **OPNsense 24.1 "Savvy Shark"** (released
January 30, 2024) or later. Verified two independent ways:

1. The official changelog (`opnsense/changelog`, `community/24.1/24.1`):
   *"firewall: add automation category for filter rules and source NAT using
   MVC/API, formerly known as os-firewall plugin"* and *"plugins: os-firewall
   moved to core."*
2. The exact core commit that introduced these controllers —
   `8e299d3e` (2024-01-07), *"import net/os-firewall from plugins"*
   ([opnsense/core#6390](https://github.com/opnsense/core/issues/6390)) —
   which added `FilterController.php`, `FilterBaseController.php` AND
   `SourceNatController.php` in the SAME commit.

Before 24.1, this functionality existed only as a separately-installed
"os-firewall" plugin (not guaranteed present, not core). On an un-upgraded
pre-24.1 box, every `firewall-rules`/`source-nat` endpoint returns **404**,
not a validation error.

**No name field — identity is the canvas item.** Unlike aliases/categories, a
pf filter rule or outbound-NAT rule has NO name field at all (verified in
`Filter.xml`). This app therefore reconciles by the **canvas item's own
stable id** (`CanvasItemSnapshot.id`), mapped to the OPNsense-assigned `uuid`
and carried across deploys in `rollbackData` — the same "audit trail"
approach this codebase's Akamai `network-lists` app uses for a resource whose
natural key can't be trusted, adapted here to a resource with no natural key
at all. `description` is **required by this app's own canvas** (not by
OPNsense) purely so every rule has a human label; it plays no role in
matching. Because every tracked rule was created by this app (there's no
"pre-existing, not ours" case the way there is for name-matched aliases), a
tracked item removed from the canvas is always deleted on the next deploy.

**Ordering, handled honestly.** `sequence` (1–999999) only orders a rule
*within* an automatically-computed bucket — verified in
`FilterRuleContainerField::getPriority()` /
`FilterRuleField::actionPostLoadingEvent()`, which run on every model load:

- 0 or 2+ interfaces, or "invert interface" set → **floating** (evaluated
  first, regardless of any single-interface rule's sequence)
- a single interface that is itself an OPNsense interface **group**
- a single ordinary interface (the common case)
- an interface that doesn't exist in the config → treated as invalid, sorted
  last

`sort_order = "{bucket}.0{sequence:06d}"` is computed server-side on every
load; this app never writes `sort_order` or `prio_group`, only `sequence`.
It does **not** replicate the UI's drag-and-drop gap-renumbering
(`moveRuleBefore`) — declare well-spaced `sequence` values (10, 20, 30, ...)
for easy future insertion.

**Categories by name.** Both rule types can reference `firewall-categories`
by name in the canvas; deploy resolves each to its live uuid before staging
anything, failing the whole deploy (not partially) if a name doesn't resolve.

**Source NAT's mode gate — surfaced, not silently ignored.** Manual
`snatrules.rule` entries only take effect on the wire when OPNsense's
system-wide Outbound NAT mode (`general.snat_mode`, set on the OPNsense GUI's
Firewall > NAT > Outbound page — NOT by this config type) is **Hybrid** or
**Manual**. In the default **Automatic** mode (or **Disabled**), this app's
rules stage into `config.xml` and `apply` reloads the ruleset successfully,
but the rules have **zero real effect** — OPNsense generates its own
automatic outbound rules instead. This app never changes that global
setting; it reads it (`GET /api/firewall/source_nat/get`, best-effort parsing
of an option field's form representation) and surfaces a prominent warning in
the deploy's own success message and as a non-fatal `healthCheck` item.

**Why Source NAT and 1:1 NAT, but not Port Forward or NPTv6.** `Filter.xml`
(one shared model) also backs `npt.rule` (NPTv6), and a separate model backs
Destination NAT (port forwarding). All four NAT surfaces on this model were
evaluated; two were built:

- **Source NAT**, shipped in the *original* January 2024 import alongside
  Firewall Rules and actively, incrementally maintained since (including a
  legacy-outbound-NAT-to-Source-NAT config migration as recently as June
  2026) — the best-verified, most mature NAT surface available.
- **1:1 NAT** got its own MVC/API conversion later, pinned to **OPNsense
  24.1.9** (June 18, 2024) — see its own section below — and was built once
  that floor was confirmed precisely, not just assumed to ride on 24.1.
- **Port Forward / Destination NAT** (`DNatController.php`) was NOT built —
  its MVC/API conversion is much newer (**2025-12-02**) with substantial
  follow-on churn since (anti-lockout rules, a `ProtocolField` special-case
  fix in January 2026, further changes through July 2026). Under a year old
  with that much ongoing change was judged too high a correctness risk for
  this release; see the Coverage section.
- **NPTv6** (`npt.rule`) was not evaluated in depth this release — flagged as
  future work in Coverage, not excluded for a structural reason.

## 1:1 NAT

**Version floor: OPNsense 24.1.9 (June 18, 2024) or later** — more precise
than Firewall Rules/Source NAT's 24.1 floor. Verified two ways: (1)
`OneToOneController.php`'s own git history shows its OLDEST commit is
`cd81bcc9` (2024-04-25, *"Firewall: NAT: One-to-One - refactor to MVC,
closes opnsense/core#7250"*) — LATER than the 24.1 base import — and (2) the
official changelog pins the exact shipping release:
`community/24.1/24.1.9` (dated June 18, 2024): *"This is the last bit of
preparation for the upcoming 24.7 series reimplementing one-to-one NAT using
MVC/API."* On a box running 24.1–24.1.8, Firewall Rules/Source NAT work but
`one-to-one-nat` still 404s.

Otherwise structurally identical to Firewall Rules/Source NAT:
`onetoone.rule` (same shared `Filter.xml` model) has no name field, so this
app reconciles by canvas item id; `apply` is the same lenient,
passthrough-contract `/api/firewall/one_to_one/apply` (inherited unmodified
from `FilterBaseController`, the exact same backend command as Firewall
Rules/Source NAT's apply); `categories` resolves by name the same way.

## Unbound (DNS Resolver) overrides

Two config types, both against `/api/unbound/settings` with no meaningful
version floor (this controller's host/forward CRUD has existed since at
least mid-2021 — oldest relevant commit *"unbound: integrate DoT grid; closes
#5101"*, 2021-07-19) — and both applying via the SAME
`POST /api/unbound/service/reconfigure` call.

**FLAGGED — this restarts Unbound, not a soft reload.**
`ApiMutableServiceControllerBase::reconfigureAction()`'s default
`reconfigureForceRestart()` returns `1`, so this call STOPS THEN STARTS the
resolver service. Every deploy or rollback that touches a host or domain
override causes a brief DNS resolution gap on the box — this is the OPNsense
API's own behavior, not something this app's client chose or could avoid by
calling a different action; there is no separate "soft reload" endpoint for
these two resources.

**Host overrides** (`unbound-host-overrides`) map onto `hosts.host`,
reconciled by the (hostname, domain) pair. Supports A/AAAA/MX/TXT records
with the model's own per-record-type required fields (`server` for
A/AAAA, `mxprio`+`mx` for MX, `txtdata` for TXT) replicated client-side.
Deleting a host override also deletes any dependent CNAME-style host
aliases (`aliases.alias`) — verified in `delHostOverrideAction` — a
resource this app does not otherwise manage (see Coverage).

**Domain overrides** (`unbound-domain-overrides`) are the modern MVC
replacement for the legacy "Domain Override" concept — **there is no
separate endpoint for it**. It is represented by `dots.dot` with
`type: "forward"` (the model's other value, `"dot"`, is DNS-over-TLS).
`addForwardAction`/`setForwardAction` FORCE `type: "forward"` via their own
`addBase`/`setBase` overlay regardless of what is sent, so this config type
can only ever create or manage plain forwards. **FLAGGED:** if a domain this
app declares was independently configured as a DNS-over-TLS entry via the
GUI, this app's next deploy silently converts it to a plain forward — verified
server behavior (the overlay applies on `setForward` too), not a guess, and
worth knowing before pointing this config type at a domain someone else
manages via DoT. `domain` is required by this app's own canvas even though
the model itself allows a blank domain as a system-wide default/catch-all
forward — a use case this app does not support (see Coverage).

## Traffic Shaper (pipes, queues, rules)

Three config types over ONE shared model (`TrafficShaper.xml`,
`/api/trafficshaper/settings`), applying via the SAME
`POST /api/trafficshaper/service/reconfigure` (a custom override — reloads
the `OPNsense/Shaper` and `OPNsense/IPFW` templates, then runs
`shaper reload` and `ipfw reload`, only returning `{"status":"ok"}` if BOTH
succeed). No meaningful version floor (this controller predates 2020).

**Verb naming, double-checked against docs.opnsense.org, not just PHP source
reading:** the official API reference table for this module documents
commands in underscore_case (`add_pipe`, `search_pipes`, `set_queue`, ...)
while this app's client uses camelCase (`addPipe`, `searchPipes`,
`setQueue`); both are BYTE-IDENTICAL once OPNsense's router applies its
`ucwords`/`lcfirst` transform (see `lib/opnsenseCore.ts`'s URL-segment
doc) — confirmed by cross-referencing both sources rather than trusting
either alone. `search` verbs are PLURAL (`searchPipes`, not `searchPipe`)
while `add`/`set`/`del` are singular — a real, easy-to-get-wrong asymmetry.

**Pipes** (`traffic-shaper-pipes`) are the bandwidth cap; `description` is
`Required: Y` on the model itself, so this app safely uses it as a natural,
unique-per-canvas identity (unlike the pf-rule-family types above). The
pf dnpipe `number` is SERVER-ASSIGNED — `addPipeAction` overlays
`{origin: "TrafficShaper", number: (new TrafficShaper())->newPipeNumber()}`
onto whatever is posted, silently overwriting any value this app might send
— so `PipeBody` doesn't even declare a `number` field; the response's
`uuid` is this app's only handle on a created pipe, like every other
resource here.

**Queues** (`traffic-shaper-queues`) attach to a pipe by NAME
(`pipe_name` in the canvas), resolved to the pipe's live uuid at deploy
time — the same "declare by name, resolve at deploy" pattern
`firewall-rules`/`source-nat`/`one-to-one-nat` use for category references.
`description` is also `Required: Y` here, so it is likewise this app's
identity.

**Rules** (`traffic-shaper-rules`) match traffic INTO a pipe or queue —
`target_name` in the canvas is resolved against BOTH resources' live
descriptions at deploy time (whichever matches wins). Unlike pipes/queues,
a shaper rule's `description` is NOT required by the model — so, like
Firewall Rules, this app reconciles by the canvas item's own id and
requires `description` in its own canvas purely for a human label.

## Static Routes

`/api/routes/routes`, no meaningful version floor (oldest relevant commit:
*"rewrite static routes"*, 2017-07-30). Two details verified directly from
source rather than assumed from naming conventions:

- **The action names are genuinely all-lowercase, no camelCase at all** —
  `searchrouteAction`, `addrouteAction`, `setrouteAction`, `delrouteAction`
  (compare `FilterController`'s `searchRuleAction`). Confirmed twice: once
  reading `RoutesController.php` directly, once cross-checking
  docs.opnsense.org's own endpoint table for the `routes` module, which
  lists the identical spelling. Sending `searchRoute` (camelCase) would
  resolve to a DIFFERENT, nonexistent method and 404.
- **The model's own field is `descr`, not `description`** — the one
  resource in this app where that differs; `RouteBody.descr` is spelled to
  match.

`gateway` is a NAME from OPNsense's own configured gateway list
(`JsonKeyValueStoreField`, populated via `interface gateways list -g`) —
this app cannot enumerate or validate it offline; an unresolvable gateway
name is left to OPNsense's own validation response. The model's `route`
node is a top-level `ArrayField` (mount `//staticroutes`), NOT nested under
a named sub-container the way every other resource in this app is.

**Deferred OS-level delete.** `setrouteAction`/`delrouteAction` write the
route's OLD network value to a `/tmp/delete_route_<uuid>.todo` marker file
before staging the change, so `reconfigure` (`interface routes configure`)
knows which routes to remove from the live routing table even though
`config.xml` no longer has the old value. This is entirely server-side
bookkeeping this app's client doesn't (and can't) replicate — stage then
apply once is still the complete, correct sequence.

## Authentication

An API key/secret pair, generated per OPNsense user (**System > Access >
Users > &lt;user&gt; > API keys**). Store the **key** in the credential
**Username** field and the **secret** in **Password** (or **API token**) —
this client reads the secret from either. The owning user's Effective
Privileges must cover every page whose config type you enable — Firewall:
Aliases/Categories/Rules/NAT, Services: Unbound DNS, Firewall: Traffic
Shaper, and System: Routes, respectively.

## Component

Register an `opnsense-firewall` component whose **hostname** is the same
address the OPNsense GUI is reachable at. API requests go to
`https://<host>:<port>/api/<module>/<controller>/<command>` (port defaults to
443, the same HTTPS port the GUI uses, unless the component names another).

## TLS

An OPNsense box (the appliance the customer already runs — this is a
config-only app, not a BYOL-hosted one) ships a **self-signed certificate**
by default until an administrator installs a CA-signed one. This app talks
to it over `node:https` with its own `https.Agent`, independent of the
platform's global `fetch` — so **Verify TLS certificate** genuinely controls
whether the certificate is checked (off by default). Turn it on once a
CA-signed certificate is installed.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `verify_tls` | `false` | Enforce a valid TLS certificate on the OPNsense GUI/API endpoint. |
| `request_timeout_seconds` | `30` | Per-request timeout for OPNsense API calls. |

## References

- [OPNsense API development docs](https://docs.opnsense.org/development/api.html) — base URL pattern, HTTP Basic auth, request/response conventions.
- [`AliasController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/AliasController.php) — `addItem`/`setItem`/`delItem`/`searchItem`/`reconfigure` action bodies; the `whereUsed()`/`refactor()` in-use and rename-reference behavior.
- [`CategoryController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/CategoryController.php) / [`Category.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/Category.xml) — the category model (no apply step), `isUsed()`/`refactor()`, and the `auto` system-managed flag.
- [`FilterController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/FilterController.php) / [`FilterBaseController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/FilterBaseController.php) — `addRule`/`setRule`/`delRule`/`searchRule`/`apply` action names, `searchRecordsetBase`'s `rowCount: 9999` default (vs. alias/category's `-1`), and `moveRuleBefore`'s gap-renumbering (not replicated by this app).
- [`SourceNatController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/SourceNatController.php) — extends `FilterBaseController` unmodified for `apply`; its own `snat_mode`-aware `searchRuleAction` and automatic-rule synthesis.
- [`OneToOneController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/OneToOneController.php) — 1:1 NAT, built this release; version floor pinned via its own git history (`gh api repos/opnsense/core/commits?path=...`).
- [`DNatController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/DNatController.php) — Destination NAT/port forward, evaluated and NOT built this release; see "Why Source NAT and 1:1 NAT, but not Port Forward or NPTv6" above and the Coverage section.
- [`Router.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/library/OPNsense/Mvc/Router.php) — `parsePath()`'s exact `ucwords`/`lcfirst`/`str_replace('_','', ...)` URL-segment-to-class/method transform, the authoritative source for every module/controller/action spelling in this app (including the genuinely all-lowercase Routes verbs and the underscore-requiring multi-word module names).
- [`ApiMutableServiceControllerBase.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableServiceControllerBase.php) — the generic `start`/`stop`/`restart`/`reconfigure`/`status` service-controller base class Unbound's `ServiceController` inherits unmodified; `reconfigureForceRestart()`'s default (`1`, i.e. always stop+start) is what makes Unbound's apply step restart the resolver.
- [`Unbound/Api/SettingsController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Unbound/Api/SettingsController.php) / [`Unbound.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Unbound/Unbound.xml) — host overrides (`hosts.host`), the `dots.dot`/`type` overlay behind domain overrides, and the ACL/DNSBL/host-alias resources this app does not manage (see Coverage).
- [`TrafficShaper/Api/SettingsController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/TrafficShaper/Api/SettingsController.php) / [`ServiceController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/TrafficShaper/Api/ServiceController.php) / [`TrafficShaper.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/TrafficShaper/TrafficShaper.xml) — pipe/queue/rule field sets, the server-assigned `number` overlay, and the two-template/two-command `reconfigure` override.
- [`Routes/Api/RoutesController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Routes/Api/RoutesController.php) / [`Route.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Routes/Route.xml) — the all-lowercase verbs, the `descr` field name, and the deferred-delete `.todo` marker mechanism.
- [docs.opnsense.org API reference](https://docs.opnsense.org/development/api/core/trafficshaper.html) (and its `routes.html`/`unbound.html`/`firewall.html` siblings) — the OFFICIAL endpoint tables, used to cross-check every module/command spelling in this app independently of reading PHP source; confirms `trafficshaper` (one word) as the correct module segment (a `traffic_shaper` guess would only work via a case-insensitive namespace-resolution fallback, not the primary router path) and that `d_nat` (with underscore) is Destination NAT's real segment.
- [`Wireguard/Api/{Server,Client,Service}Controller.php`](https://github.com/opnsense/core/tree/master/src/opnsense/mvc/app/controllers/OPNsense/Wireguard/Api) / `Server.xml` / `Client.xml` — evaluated and NOT built; `Server.xml`'s `privkey` being `Required: Y` with a server-side `keyPair` generator is the exact, verified reason WireGuard is excluded (see Coverage).
- [`ApiMutableModelControllerBase.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableModelControllerBase.php) — the generic `addBase`/`setBase`/`delBase`/`getBase`/`searchBase` response shapes (`{result, uuid, validations}` / `{rows, rowCount, total, current}`) every mutable-model controller shares — the basis for this app's `buildModelResource()` factory.
- [`ApiControllerBase.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Base/ApiControllerBase.php) — HTTP Basic key/secret auth, the `{status, message}` 401/403/400 envelopes, the JSON-body-parsing requirement, and `searchRecordsetBase`'s own `rowCount` default.
- [`Alias.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/Alias.xml) / [`Filter.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/Filter.xml) — the alias model's full field set and `type` enum; the ONE shared model backing `rules.rule` / `snatrules.rule` / `npt.rule` / `onetoone.rule` and `general.snat_mode`.
- [`AliasContentField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasContentField.php) — the `\n` content separator and the per-type content validators this app's `validateContentEntry` mirrors.
- [`AliasNameField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasNameField.php) — the exact name regex and reserved pf-keyword list this app's `validate.ts` mirrors.
- [`FilterRuleField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/FilterRuleField.php) — `getPriority()`/`actionPostLoadingEvent()`, the exact source of the ordering rules documented above.
- [`BaseField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Base/FieldTypes/BaseField.php) / [`BaseModel.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Base/BaseModel.php) — `setValue`'s `(string)` cast and `setNodes`' array-input rejection, which drove the "always send a string, never an array" wire-format rule above (applies to every resource in this app, not just aliases).
- [`UIModelGrid.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/library/OPNsense/Base/UIModelGrid.php) — `searchItem`'s flat row shape and the `rowCount: -1` ("all results") default alias/category search relies on.
- [`FirmwareController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Core/Api/FirmwareController.php) — `statusAction`'s GET/POST behavior, used for the connection test.
- [OPNsense 24.1 "Savvy Shark" changelog](https://github.com/opnsense/changelog/blob/master/community/24.1/24.1) (`opnsense/changelog`) — official confirmation that the Firewall Automation filter/source-NAT API moved from a plugin into core in this release.
- [`opnsense/core` commit `8e299d3e`](https://github.com/opnsense/core/commit/8e299d3e) — "import net/os-firewall from plugins", the exact commit that introduced `FilterController.php`/`FilterBaseController.php`/`SourceNatController.php`.
- [OPNsense 24.1.9 changelog](https://github.com/opnsense/changelog/blob/master/community/24.1/24.1.9) (`opnsense/changelog`, dated June 18, 2024) — official confirmation of the 1:1 NAT MVC/API reimplementation's exact shipping release.

### Not modeled (flagged, not faked)

See the CHANGELOG's "Not modeled" sections and the Coverage section below —
`authgroup` aliases, `internal`/`external` alias types, URL Table
authentication, `expire`, per-rule advanced pf tuning knobs, schedules,
traffic-shaper pipe/queue relations on `firewall-rules` (not needed — this
app's OWN traffic-shaper types model those directly), WireGuard, Destination
NAT/Port Forward, and NPTv6 were all deliberately scoped out rather than
half-implemented.

## Development

```
cd apps/opnsense
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs opnsense          # run handler tests
node ../../scripts/validate-app.mjs apps/opnsense  # validate against the app contract
```

## Coverage

As of v0.3.0 this app manages every OPNsense configuration surface that is
(a) reachable through a documented, current REST API, (b) genuinely
"declarative config" in the sense this app's pipeline model (validate →
deploy → drift-detect → rollback) is built for, and (c) safe to hold in a
canvas configuration without embedding secret/key material. Everything else
is either **excluded for a structural reason** (won't be built, ever, under
this app's current architecture) or **not yet built** (a legitimate future
config type this release simply didn't reach). This section, plus the
CHANGELOG's per-version "Not modeled" notes, is the authoritative list.

### Managed (11 configuration types)

| Group | Configuration types |
| --- | --- |
| Firewall | Aliases, Categories, Rules |
| NAT | Source NAT (outbound), 1:1 NAT |
| Services | Unbound Host Overrides, Unbound Domain Overrides |
| Traffic Shaping | Pipes, Queues, Rules |
| Routing | Static Routes |

Every write goes through the exact same verified pattern: `buildModelResource()`
(`lib/opnsenseCore.ts`) for the controller's real add/set/del/search verbs,
every field sent as a string (never a JSON array — see the "field, not an
array" note above), stage every change, then call the resource's own apply/
reconfigure step exactly once per deploy or rollback.

### Excluded, structurally (drop, don't fake)

- **VPN key material — WireGuard** (`/api/wireguard/{server,client}/*`).
  `Server.xml`'s `privkey` (`Base64Field`) is `Required: Y` — a WireGuard
  server literally cannot be created without a private key.
  `ServerController::keyPairAction()` generates one server-side, but
  persisting it would mean the private key transits through this app's
  canvas configuration and `rollbackData`, neither of which is a
  Credential-Vault-backed secret store. Client (peer) records also carry a
  `psk` (pre-shared key) and require bidirectional Server↔Client `peers`
  CSV synchronization. See the CHANGELOG's "Dropped, with full reasoning"
  section for the complete citation trail.
- **Certificates and CAs** (`/api/trust/*`). A certificate's private key is
  the same category of secret as a WireGuard key — legitimately needed to
  use the certificate, but not something this app puts in a canvas
  configuration. (Not evaluated in the same file-by-file depth as WireGuard
  this release, but excluded for the identical structural reason.)
- **Interface / hardware assignment** (`/api/interfaces/*`). Which physical
  or virtual NIC maps to "wan"/"lan"/etc. is a property of the box itself,
  not a portable declarative config value — every config type in this app
  already takes an interface NAME as a plain string precisely because
  assigning interfaces is out of scope.
- **System actions** (firmware upgrade/audit, reboot/poweroff, config
  backup/restore, service start/stop/restart, diagnostics). These are
  one-shot operations or read-only telemetry, not desired-state resources a
  validate → deploy → drift → rollback pipeline models meaningfully. The
  connection test already uses one read-only example
  (`GET /api/core/firmware/status`) precisely because it has no side effect.
- **Rule/record reordering UI conveniences** (`moveRuleBefore` on every
  pf-rule-family controller, CSV import/export, `toggle*` actions). This
  app's `sequence` field already achieves the same reordering outcome
  declaratively (see "Ordering, handled honestly" above) — replicating the
  UI's specific gap-renumbering algorithm on top of that would be pure
  duplication with no config-as-code benefit.

### Not yet built (future work — no structural blocker)

- **Unbound ACLs, DNSBL blocklists, host aliases (CNAME-style), and
  DNS-over-TLS entries.** All confirmed cleanly writable via the SAME
  `Unbound/Api/SettingsController.php` this app already uses
  (`add_acl`/`add_dnsbl`/`add_host_alias`/the `type: "dot"` half of
  `dots.dot`) — verified against docs.opnsense.org's own endpoint table,
  not just inferred. Host aliases specifically depend on
  `unbound-host-overrides` already existing (their `host` field is a
  `ModelRelationField` into it), so they'd naturally be v0.4+ work.
- **Destination NAT / Port Forward** (`d_nat` module — note the verified
  underscore in its URL segment). Evaluated and explicitly not built this
  release due to its very recent (2025-12-02) MVC conversion and high
  ongoing change velocity — see "Why Source NAT and 1:1 NAT, but not Port
  Forward or NPTv6" above. A good candidate once it stabilizes.
- **NPTv6** (`npt.rule`, the fourth resource on the shared `Filter.xml`
  model alongside Rules/Source NAT/1:1 NAT). Not evaluated in the same
  depth as the other three this release; structurally it would follow the
  same itemId-based-reconcile pattern as 1:1 NAT almost exactly.
- **IPsec, OpenVPN, DHCP (Kea and legacy ISC), gateway groups.** Real
  OPNsense subsystems with their own MVC/API controllers
  (`OPNsense/IPsec`, `OPNsense/OpenVPN`, `OPNsense/Kea`, `OPNsense/DHCRelay`,
  `OPNsense/Routing/Api/GroupSettingsController`) that were not researched
  in this app's build-out at all — genuinely unknown coverage, not
  evaluated-and-rejected the way WireGuard/Port-Forward/NPTv6 were.
- **`firewall-aliases` referencing `firewall-categories` by name.** Added
  for `firewall-rules`/`source-nat`/`one-to-one-nat`/the traffic-shaper
  types in v0.2.0–v0.3.0; retrofitting the same category-by-name pattern
  onto aliases is low-risk follow-up work, not attempted this release.
