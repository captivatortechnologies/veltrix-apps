# 📡 Darktrace

Manage a [Darktrace](https://www.darktrace.com) NDR (Network Detection & Response)
deployment's **writable surfaces** as code on the Veltrix Security-as-Code platform.
Author intel-feed watched domains / IPs / hostnames and named tags in the Configuration
Canvas and drive them through the pipeline (validate → deploy → rollback → health-check
→ drift-detect → status).

## An honest note on Darktrace's API (historical v0.2.0 note; superseded by Coverage below)

Darktrace's REST API is **read-heavy**. The bulk of it reports *out* of the platform
— model breaches, device summaries, AI Analyst incidents, connection details,
`/status`, `/summarystatistics`. Comparatively little is designed to be written as
configuration. Researching the official API (customer portal + the public
`LegendEvent/darktrace-sdk` and `madsky/dtapi` clients) for genuinely-writable,
config-shaped surfaces, this app manages the two clean ones:

- **Intel feed** (`/intelfeed`) — the watched-domain list that feeds Darktrace's
  detections and, optionally, Antigena responses. This **is** the "Watched Domains"
  feature; there is no separate watched-domains endpoint.
- **Tags** (`/tags`) — named labels used to group entities and drive model logic:
  create by name, delete by id, no edit.

Deliberately **not** included, for honesty: `/filtertypes` is **read-only** (Model
Editor filter discovery); `/subnets` is writable but keyed on a required numeric
`sid` (edit an existing *discovered* subnet), a weaker config-as-code fit; and model /
component editing is complex and not cleanly declarative. This app does not pretend
the rest of the API is configuration-as-code.

## How it's managed

Darktrace exposes its REST API over HTTPS (443), authenticated with the **DSA**
("Darktrace Signed API") scheme — a **two-token** pair:

- **Public token** — sent in the clear as the `DTAPI-Token` header. Stored as the
  connection credential's **username**.
- **Private token** — the HMAC secret, never sent. Stored as the connection
  credential's **secret** (API token).

Every request carries three headers:

| Header | Value |
|---|---|
| `DTAPI-Token` | the public token |
| `DTAPI-Date` | a UTC timestamp, compact form `YYYYMMDDTHHMMSS` (e.g. `20250115T143022`) |
| `DTAPI-Signature` | `HMAC-SHA1( privateToken, "<request-uri incl. sorted query>\n<publicToken>\n<date>" )`, hex |

Query parameters are sorted alphabetically in **both** the signed string and the wire
request. Darktrace appliances commonly present a **self-signed certificate**, which
the transport tolerates. The signing assembly is isolated in `lib/darktraceApi.ts`
and pinned by unit tests (`lib/__tests__/darktraceApi.test.ts`).

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Watched Domains** | Darktrace REST API (`GET/POST /intelfeed`) | ✅ v0.1.0 |
| **Tags** | Darktrace REST API (`GET/POST /tags`, `DELETE /tags/{tid}`) | ✅ v0.2.0 |

### Watched Domains

Each item is one watched entry: a domain / IP / hostname, its watched-list **source**,
an optional **description** and **expiry**, and the **hostname** and **Antigena
(iagn)** flags. The entry name is the stable identity:

- **deploy** reads the live feed (`GET /intelfeed?fulldetails=true`) and adds only
  entries not already present (`POST /intelfeed` with `addentry`), recording exactly
  what it created — Darktrace's intel feed is append/remove only, so this is an
  idempotent upsert (no per-entry edit).
- **rollback** removes exactly the entries this deploy added (`POST /intelfeed` with
  `removeentry`).
- **drift-detect** flags any declared entry that has been removed upstream.
- **health-check / connectivity test** hit `GET /intelfeed?sources=true` — a
  lightweight, DSA-signed read that confirms reachability + a valid signature.

### Tags

Each item is one tag: a **name** (the stable identity), an optional HSL-hue **colour**
(0–360) and a **description**. Darktrace's tags are create/delete only (no edit):

- **deploy** reads the live tags (`GET /tags`) and creates only tags not already
  present (`POST /tags` with `name`, optional `color` / `description`), recording the
  numeric `tid` of each tag it created so rollback can delete it precisely. When the
  create response omits the new `tid` it is resolved with one follow-up `GET /tags`.
- **rollback** deletes exactly the tags this deploy created (`DELETE /tags/{tid}`).
- **drift-detect** flags any declared tag that has been deleted upstream.
- **health-check** hits `GET /tags?responsedata=name` — a lightweight, DSA-signed read.

## Verify against a live Darktrace

The DSA details above are confirmed against multiple public Darktrace API clients but
should be re-verified against your appliance:

1. **HMAC algorithm is SHA1** (not SHA256). Some third-party write-ups say SHA256 —
   do not switch without a live check.
2. **`DTAPI-Date` is the compact basic form** `YYYYMMDDTHHMMSS`, not dashed/colon ISO.
3. **POST body vs. signature** — on the clients verified, the signature covers the
   request URI (path) and `/intelfeed` write parameters travel in the JSON body;
   confirm newer builds do not additionally sign the body.
4. **Intel-feed parameter names** (`addentry`, `addlist`, `source`, `description`,
   `expiry`, `hostname`, `iagn`, `removeentry`) and the accepted **expiry** format.
5. **Tags** — the `POST /tags` create-response shape (in particular whether it returns
   the new `tid`; deploy falls back to a `GET /tags` lookup by name if not), the
   `DELETE /tags/{tid}` form, and the accepted **colour** range (HSL hue 0–360).

TLS verification is off by default (self-signed) and surfaced via the `verify_tls`
setting.

## Development

```
cd apps/darktrace
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs darktrace             # run handler tests
node ../../scripts/validate-app.mjs apps/darktrace      # validate against the app contract
```

## Coverage (v0.2.0)

Darktrace does not publish its API Guide outside the customer support portal,
so this pass re-audited every write path against the full **26-endpoint-module**
surface of [LegendEvent/darktrace-sdk](https://github.com/LegendEvent/darktrace-sdk)
(actively maintained, `tests/test_post_delete.py` exercises every `POST`/`DELETE`
call across the SDK), cross-checked against
[madsky/dtapi](https://github.com/madsky/dtapi) and the
[tur11ng/darktrace-cheatsheet](https://github.com/tur11ng/darktrace-cheatsheet)
Model Editor notes. Every module the client exposes (`advanced_search`,
`analyst`, `antigena`, `breaches`, `components`, `cves`, `details`,
`deviceinfo`, `devices`, `devicesearch`, `devicesummary`, `email`,
`endpointdetails`, `enums`, `filtertypes`, `intelfeed`, `mbcomments`,
`metricdata`, `metrics`, `models`, `network`, `pcaps`, `similardevices`,
`status`, `subnets`, `summarystatistics`, `tags`) was inspected for a write
method. This app's write surface is unchanged from v0.2.0 — no genuinely
declarative config was found beyond what is already built.

### Managed declarative configuration

| Configuration type | Darktrace REST operations |
| --- | --- |
| Watched Domains | `GET`/`POST /intelfeed` — add / remove entries; no per-entry edit |
| Tags | `GET`/`POST /tags`, `DELETE /tags/{tid}` — create / delete tags; no edit |

Both are named, list-owned resources with a stable identity (the entry / the
tag name) and a create-or-delete lifecycle that does not depend on Darktrace
having already discovered some other entity first — the shape a
Configuration Canvas item needs.

### Intentionally excluded

Sixteen modules (`components`, `cves`, `details`, `deviceinfo`, `devicesearch`,
`devicesummary`, `endpointdetails`, `enums`, `filtertypes`, `metricdata`,
`metrics`, `models`, `network`, `similardevices`, `status`,
`summarystatistics`) expose **`GET` only** — no write method exists at all.
Two calls out from that list, since they were named candidates for this pass:

- **`/models` and `/components`** — the "model editing/config" candidate.
  Confirmed **read-only**. Darktrace's Model Editor is a Threat Visualizer
  console feature; it is not backed by a documented, writable REST endpoint.
  There is nothing here to author as config — not "complex," simply absent.
- **`/filtertypes`** — the Model Editor's filter-type catalogue. Confirmed
  **read-only** (`GET` only), matching the original v0.1.0 finding.

No **"banners"** endpoint (a login banner / message-of-the-day setting) exists
anywhere in the audited surface, across all three sources checked.

The remaining ten modules do write at least one endpoint. None is a
config-as-code fit:

| Module / endpoint | Write | Why excluded |
| --- | --- | --- |
| `/devices` | `POST` | Edits `label`/`priority`/`type` on an already-discovered device, keyed by a numeric `did` Darktrace assigns. No create — you cannot declare a device before Darktrace has modeled it. |
| `/subnets` | `POST` | Confirmed writable but keyed on a required, pre-existing numeric `sid` — edits a subnet Darktrace has already modeled, not creating one. Same "requires an id you don't have yet" shape as devices. Unchanged finding from v0.2.0. |
| `/tags/entities`, `/tags/{tid}/entities` | `POST`/`DELETE` | Assigns/removes a tag on a specific, already-discovered device or credential, optionally for a bounded `duration`/`expiryDuration`. A live, time-bound operational binding to a runtime-discovered entity — not a durable config object, and its own expiry makes it non-idempotent as desired state. |
| `/modelbreaches/{pbid}/acknowledge`, `/unacknowledge`, `/comments`; `/mbcomments` | `POST` | Triage actions (acknowledge / unacknowledge / comment) against a specific model-breach alert *instance* (`pbid`/`breachid`). A model breach is an event, not a configuration object — nothing to declare, deploy or roll back. `/mbcomments` was this pass's "mbcomments-if-config" candidate: it is the same alert-instance-triage shape as the `/modelbreaches` comment endpoints, not a config surface. |
| `/antigena`, `/antigena/manual` | `POST` | Activate / extend / clear / reactivate a RESPOND action, or manually create one (quarantine, block connections, enforce pattern-of-life). Imperative incident-response actions carrying a runtime duration — the opposite of declarative config. |
| `/aianalyst/*` | `POST` | Acknowledge / unacknowledge / pin / unpin / comment / create-investigation against AI Analyst incidents. Same event/instance-triage shape as model-breach actions. |
| `/agemail/...` (Darktrace/Email) | `POST` | A distinct product (Darktrace/Email) exposing message-level actions (release/hold a message, search). Imperative per-message actions, not tenant configuration, on a different product surface than the NDR REST API this app targets. |
| `/pcaps` | `POST` | Requests an on-demand packet capture over a time window — a job request, not a durable resource. |
| `/advancedsearch/api/search` | `POST` | Darktrace's advanced-search query. `POST` here is only request-body transport for a large search body (an Elasticsearch-style query) — a read, not a write. |

With intelfeed and tags built, and every other write-capable endpoint
confirmed as either identity-less (requires a Darktrace-discovered id it
cannot be given in advance), ephemeral/time-bound, or an imperative action
rather than durable desired state, this app's config-as-code surface is
exhausted against the documented API. Darktrace's own API Guide is gated
behind the customer support portal and was not directly accessible for this
pass — if it surfaces additional writable, config-shaped endpoints, re-audit
against it directly.

Apache-2.0.
