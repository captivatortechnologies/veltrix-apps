# OPNsense (Veltrix app)

Manage [OPNsense](https://opnsense.org) open-source firewall configuration as
code through its **REST API**, driven by the Veltrix Security-as-Code
pipeline (validate → deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | OPNsense object | API commands |
| --- | --- | --- |
| **Firewall Aliases** (`firewall-aliases`) | Firewall alias objects | `searchItem` (list), `addItem`, `setItem`, `delItem`, `reconfigure` (apply) |

Reconciles by alias **name** and targets an `opnsense-firewall` component.

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

1. `POST /api/firewall/alias/addItem` / `setItem/<uuid>` / `delItem/<uuid>` —
   each of these only **stages** the change into the pending configuration
   (`config.xml` in memory, then on disk). Nothing on the wire changes yet.
2. `POST /api/firewall/alias/reconfigure` — the **apply** step. It runs
   `filter reload skip_alias`, `template reload OPNsense/Filter` and
   `filter refresh_aliases` on the box, which is what actually reloads the pf
   filter/alias tables.

Every deploy or rollback that stages at least one alias change calls
`reconfigure` exactly **once**, after every stage call, so the whole batch
takes effect together. Unlike a session-transactional API (this codebase's
Check Point app, for example), OPNsense has no "discard" for a partially
staged batch — if a stage call fails partway through a deploy, the aliases
staged *before* the failure remain staged (visible as pending changes on the
box) but `reconfigure` never runs, so **nothing reaches the running
firewall**. The failed deploy's `rollbackData` still records everything
staged up to that point, so rollback can cleanly undo it.

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
- [`ApiMutableModelControllerBase.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableModelControllerBase.php) — the generic `addBase`/`setBase`/`delBase`/`getBase` response shapes (`{result, uuid, validations}`) every mutable-model controller shares.
- [`ApiControllerBase.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Base/ApiControllerBase.php) — HTTP Basic key/secret auth, the `{status, message}` 401/403/400 envelopes, and the JSON-body-parsing requirement.
- [`Alias.xml`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/Alias.xml) — the alias model's full field set and `type` enum.
- [`AliasContentField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasContentField.php) — the `\n` content separator and the per-type content validators this app's `validateContentEntry` mirrors.
- [`AliasNameField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasNameField.php) — the exact name regex and reserved pf-keyword list this app's `validate.ts` mirrors.
- [`BaseField.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Base/FieldTypes/BaseField.php) / [`BaseModel.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/models/OPNsense/Base/BaseModel.php) — `setValue`'s `(string)` cast and `setNodes`' array-input rejection, which drove the "always send a string, never an array" wire-format rule above.
- [`UIModelGrid.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/library/OPNsense/Base/UIModelGrid.php) — `searchItem`'s flat row shape and the `rowCount: -1` ("all results") default this app relies on.
- [`FirmwareController.php`](https://github.com/opnsense/core/blob/master/src/opnsense/mvc/app/controllers/OPNsense/Core/Api/FirmwareController.php) — `statusAction`'s GET/POST behavior, used for the connection test.

### Not modeled in v0.1.0 (flagged, not faked)

See the CHANGELOG's "Not modeled" section — `authgroup` aliases,
`internal`/`external` types, URL Table authentication, `expire` and
`categories` were all deliberately scoped out rather than half-implemented.

## Development

```
cd apps/opnsense
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs opnsense          # run handler tests
node ../../scripts/validate-app.mjs apps/opnsense  # validate against the app contract
```
