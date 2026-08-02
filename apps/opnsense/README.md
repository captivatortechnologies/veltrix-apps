# OPNsense (Veltrix app)

Manage [OPNsense](https://opnsense.org) open-source firewall configuration as
code through its **REST API**, driven by the Veltrix Security-as-Code
pipeline (validate → deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | OPNsense object | API commands | Version floor | Reconciled by |
| --- | --- | --- | --- | --- |
| **Firewall Aliases** (`firewall-aliases`) | Firewall alias objects | `searchItem`, `addItem`, `setItem`, `delItem`, `reconfigure` (apply) | any | name |
| **Firewall Categories** (`firewall-categories`) | Metadata tags | `searchItem`, `addItem`, `setItem`, `delItem` — no apply step | any | name |
| **Firewall Rules** (`firewall-rules`) | pf filter rules | `searchRule`, `addRule`, `setRule`, `delRule`, `apply` | **OPNsense 24.1+** | canvas item id |
| **Source NAT** (`source-nat`) | Outbound NAT rules | `searchRule`, `addRule`, `setRule`, `delRule`, `apply` | **OPNsense 24.1+**, mode = Hybrid/Manual | canvas item id |

All four target an `opnsense-firewall` component. Firewall Rules and Source
NAT reconcile by the **canvas item's own id** rather than a name — a pf rule
has no name field at all (see "Firewall rules & source NAT" below).

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
   name (though filter/source-nat happen to share the same backend command):
   - `POST /api/firewall/alias/reconfigure` runs `filter reload skip_alias`,
     `template reload OPNsense/Filter` and `filter refresh_aliases`, and
     always returns the literal `{"status":"ok"}` on success
     (`AliasController::reconfigureAction`).
   - `POST /api/firewall/filter/apply` and `POST /api/firewall/source_nat/apply`
     both run `filter reload skip_alias` — a full pf ruleset reload —
     inherited unmodified from `FilterBaseController::applyAction()` (verified:
     `SourceNatController extends FilterBaseController` and does not override
     it). **FLAGGED:** unlike alias's `reconfigure`, the success value here is
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

**Why Source NAT, not 1:1 NAT or Port Forward.** `Filter.xml` (one shared
model) also backs `onetoone.rule` (1:1 NAT) and `npt.rule` (NPTv6), and a
separate model backs Destination NAT (port forwarding). All three were
evaluated for this release and NOT built:

- **1:1 NAT** (`OneToOneController.php`) got its MVC/API conversion in April
  2024 — reasonably mature, but still received a "refactor two controller
  methods as base methods" change as late as December 2025.
- **Port Forward / Destination NAT** (`DNatController.php`) is much newer —
  its MVC/API conversion landed **2025-12-02** — with substantial follow-on
  churn since (anti-lockout rules, a `ProtocolField` special-case fix in
  January 2026, further changes through July 2026).
- **Source NAT**, by contrast, shipped in the *original* January 2024 import
  alongside Firewall Rules and has been actively, incrementally maintained
  since (including a legacy-outbound-NAT-to-Source-NAT config migration as
  recently as June 2026) — the best-verified, most mature NAT surface
  available, and the one this release builds.

## Authentication

An API key/secret pair, generated per OPNsense user (**System > Access >
Users > &lt;user&gt; > API keys**). Store the **key** in the credential
**Username** field and the **secret** in **Password** (or **API token**) —
this client reads the secret from either. The owning user's Effective
Privileges must cover the Firewall: Alias page.

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
- [`OneToOneController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/OneToOneController.php) / [`DNatController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/DNatController.php) — evaluated for this release; see "Why Source NAT, not 1:1 NAT or Port Forward" above. Commit history checked via `gh api repos/opnsense/core/commits?path=...`.
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

### Not modeled (flagged, not faked)

See the CHANGELOG's "Not modeled" sections for both releases — `authgroup`
aliases, `internal`/`external` alias types, URL Table authentication,
`expire`, per-rule advanced pf tuning knobs, schedules, traffic-shaper
relations, 1:1 NAT, NPTv6 and Port Forward were all deliberately scoped out
rather than half-implemented.

## Development

```
cd apps/opnsense
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs opnsense          # run handler tests
node ../../scripts/validate-app.mjs apps/opnsense  # validate against the app contract
```
