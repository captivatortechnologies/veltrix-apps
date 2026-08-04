# Tanium

Manage [Tanium](https://www.tanium.com/) endpoint management as code. Author
Tanium **computer groups** (filter-based or manual), **saved questions**,
**packages** and **sensors** and drive them through the Veltrix
Security-as-Code pipeline — validate, deploy, health check, drift detection
and rollback — over the **Tanium REST v2 API**.

- **Category:** Endpoint Management
- **Transport:** HTTPS (443), base `https://<server>/api/v2`, self-signed
  certificate tolerated (configurable via the `verify_tls` setting).

See [Coverage](#coverage-v030) below for the full, cited audit of what this app
manages and what was deliberately left out.

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **Computer Groups** | Create / edit / delete Tanium computer groups. Two modes: **filter** — a `name` plus a filter expression (`text`) such as `Operating System contains Windows`, or an optional structured-filter JSON; **manual** — a `name` plus an explicit `computer_specs` list of computer names / IP addresses. Upsert by name; both modes read/update/delete through the same `groups` collection. | `POST /api/v2/groups` (filter) / `POST /api/v2/computer_groups` (manual), `GET/PUT/DELETE /api/v2/groups/{id}` |
| **Saved Questions** | Create / edit / delete Tanium saved questions — a `name` plus a question. Provide the question text (sent as `question.question_text` for the server to parse) or a pre-parsed Question ID (`question.id`). Upsert by name. | `GET/POST /api/v2/saved_questions`, `GET .../by-name/{name}`, `DELETE .../{id}` |
| **Packages** | Create / edit / delete Tanium packages — a `name` plus the `command` the Tanium Client runs, with optional `display_name`, command timeout and `expire_seconds`. Upsert by name. | `GET/POST /api/v2/packages`, `GET .../by-name/{name}`, `DELETE .../{id}` |
| **Sensors** | Create / edit / delete Tanium sensors — a `name` plus a primary per-platform script (`queries[]`: platform + script + script type), with optional description, category, key/default-value `parameters[]`, a result `max_age_seconds`, and extra per-platform scripts for a multi-platform sensor. Upsert by name. | `GET/POST /api/v2/sensors`, `GET .../by-name/{name}`, `DELETE .../{id}` |

## Authentication

The connection authenticates to the Tanium REST v2 API one of two ways. The
auth seam is isolated in `lib/taniumApi.ts` (`resolveTaniumSession`), and every
authenticated call carries a `session:` header:

1. **API token (preferred).** Create a token in Tanium under
   **Administration → Permissions → API Tokens** (shown once at creation). The
   token is sent verbatim as the `session:` header value — no login round-trip.
2. **Username + password.** The app POSTs
   `/api/v2/session/login` with `{ username, password }` and reads the returned
   session string from `data.session`, then sends it as the `session:` header.

Tanium does **not** use an `Authorization` / `Bearer` header — that returns 401.

Store the credential on the **Connections** page. Saving a connection also
registers the Tanium server as a `tanium-server` deploy target.

## Connectivity test

`GET /api/v2/system_status` after resolving a session. A login failure or a
401/403 proves reachability but flags the credential; any status below 500
confirms Tanium answered.

## Verify against a live Tanium

The REST v2 shapes here follow the documented v2 conventions and Tanium's public
integrations (Cortex XSOAR `Tanium_v2`, Splunk SOAR `taniumrest`, Tanium
Community). The following should be confirmed against a live Tanium before
production use:

- **`PUT /api/v2/groups/{id}` for an in-place update.** Public integrations
  delete + recreate a group rather than PATCH/PUT it; verify update semantics.
  This applies to BOTH computer-group authoring modes (filter and manual).
- **`POST /api/v2/computer_groups` for a manual group.** Confirmed as a
  distinct create endpoint from the filter-based `POST /api/v2/groups` by
  Cortex XSOAR `Tanium_v2` (`tn-create-manual-group` vs
  `tn-create-filter-based-group`); both then read/update/delete through the
  same `/api/v2/groups` collection (`tn-get-group`, `tn-delete-group`).
- **Sensor `POST`/`DELETE`.** Every source researched (Tanium's own published
  Platform REST API reference, Cortex XSOAR `Tanium_v2`, Splunk SOAR
  `taniumrest`) documents only `GET /api/v2/sensors` and
  `GET /api/v2/sensors/by-name/{name}` for sensors. Create/delete here follow
  the same generic named-entity convention already shipped for
  packages/saved-questions, but are NOT independently confirmed for sensors.
  Verify against a live Tanium, especially the `queries[].script_type` enum.
- **Structured filter JSON.** The verified authoring path is the plain-text
  `text` filter expression. The optional `filterJson` field maps to a `filters`
  spec whose exact shape (`and_flag`, per-clause `field`/`operator`/`value`) is
  not confirmed here — verify before relying on it.
- **Response envelope.** Responses are treated as possibly wrapped in
  `{ data: ... }`; both wrapped and bare forms are handled.
- **Delete + recreate for saved questions and packages.** REST v2 exposes no
  confirmed in-place update for these objects (Cortex XSOAR `Tanium_v2` and
  Splunk SOAR `taniumrest` only create, read and delete them), so an existing
  object is **replaced**: `DELETE .../{id}` then `POST`. This churns the object
  id — a saved question referenced by a dashboard, or a package referenced by a
  saved action, may need re-pointing. Verify update semantics for your workflow.
- **Saved-question inline text.** The verified create path references a
  **pre-parsed** question by id (`{ name, question: { id } }`; XSOAR
  `tn-create-saved-question` takes a question-id). Passing the question text
  inline (`{ name, question: { question_text } }`) and letting the server parse
  it is a convenience that the public integrations do not exercise — some builds
  require the pre-parse step (`POST /api/v2/parse_question` → `POST /api/v2/questions`).
  Use the **Question ID** field to take the verified by-id path.
- **Package `command_timeout_seconds`.** Only `name` + `command` are exercised by
  the public integrations. The optional command timeout maps to
  `command_timeout_seconds`; some builds name it `command_timeout`. It is sent
  only when supplied, so a name mismatch affects opt-in use only — verify the
  field name against your Tanium.

## Roadmap

- Newer **Tanium API Gateway (GraphQL)** path — noted but not implemented; the
  app targets REST v2. Tanium's own developer portal documents it as a
  separate product surface (`developer.tanium.com/site/global/apis/graphql/`);
  its mutation surface was not accessible for review (see Coverage).
- Everything else researched and NOT added — action groups, saved actions,
  user groups, roles, content sets, content-set roles, filter groups,
  dashboards and Tanium Connect plugin schedules — is documented as an
  intentional exclusion, with its specific reason, in Coverage below rather
  than left as an open roadmap item; re-open only if new REST v2 evidence for
  one of them surfaces.

## Notes

- No app-owned database or BYOL infrastructure in this foundation.
- TLS verification is off by default (on-premises appliances commonly ship a
  self-signed certificate); toggle with the `verify_tls` setting.

## Development

```
cd apps/tanium
node node_modules/typescript/bin/tsc --noEmit    # typecheck
node ../../scripts/test-apps.mjs tanium          # run handler tests
node ../../scripts/validate-app.mjs apps/tanium  # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against Tanium's own published Platform REST API
reference (`developer.tanium.com/apis/api_intro`, mirrored publicly at
[api-evangelist/tanium](https://github.com/api-evangelist/tanium/blob/main/openapi/tanium-platform-rest-api-openapi.yml))
and Tanium's public integrations — Cortex XSOAR
[`Tanium_v2`](https://github.com/demisto/content/tree/master/Packs/Tanium/Integrations/Tanium_v2)
and Splunk SOAR
[`taniumrest`](https://github.com/splunk-soar-connectors/taniumrest) — on
2026-08-04.

### Managed declarative configuration

| Configuration type | Confirmed REST v2 operations | Citation |
| --- | --- | --- |
| Computer Groups — filter mode | `POST /api/v2/groups` create, `GET .../by-name/{name}`, `GET .../{id}`, `GET .../` list, `DELETE .../{id}` | XSOAR `tn-create-filter-based-group`, `tn-get-group`, `tn-list-groups`, `tn-delete-group` |
| Computer Groups — manual mode | `POST /api/v2/computer_groups` create (reads/updates/deletes via `/api/v2/groups`, same as filter mode) | XSOAR `tn-create-manual-group` |
| Saved Questions | `POST /api/v2/saved_questions` create, `GET .../by-name/{name}`, `GET .../` list | XSOAR `tn-create-saved-question`, `tn-list-saved-questions`; Tanium Platform REST API reference |
| Packages | `POST /api/v2/packages` create, `GET .../by-name/{name}`, `GET .../` list | XSOAR `tn-create-package`, `tn-list-packages`; Tanium Platform REST API reference |
| Sensors | `GET /api/v2/sensors` list, `GET .../by-name/{name}` — CONFIRMED read-only; create/delete are an inferred extension of the generic named-entity convention, UNVERIFIED (see "Verify against a live Tanium") | XSOAR `tn-list-sensors`, `tn-get-sensor`; Tanium Platform REST API reference |

Update semantics for every type here are **delete + recreate** except
Computer Groups, whose in-place `PUT /api/v2/groups/{id}` is a REST v2
convention, not independently confirmed by either public integration.

### Intentionally excluded

- **Action groups.** Referenced everywhere (`saved_actions.action_group`,
  `actions.action_group`) only as a `{ id, name }` pointer. No source
  researched — Tanium's own Platform REST API reference, Cortex XSOAR, or
  Splunk SOAR — documents a create/update body, a list endpoint, or even the
  full read schema for an action group beyond that reference stub
  (`GET /api/v2/action_groups/by-name/{name}` returns an `ActionGroup` object
  whose fields are never enumerated). Building a config type would mean
  fabricating a schema with no basis — dropped pending real documentation.
- **Saved actions.** `POST /api/v2/saved_actions` is documented, in Tanium's
  own reference, as "**Create And Execute An Action**" — it deploys a package
  to an action group's target scope immediately on create, with no confirmed
  update or delete. Re-applying a canvas item would re-execute a live
  deployment against real endpoints on every pipeline run — the same
  imperative-action risk this app already excludes for `ask_question` /
  `execute_action`, just reached via a different endpoint. Compounded by the
  unresolvable action-group FK above.
- **User groups, roles, content sets, content-set roles, filter groups,
  dashboards.** Zero presence in any source researched — not in Tanium's own
  publicly crawlable Platform REST API reference (whose documented surface is
  exactly session/api_tokens/questions/saved_questions/saved_actions/
  action_groups/packages/sensors/groups — nothing else), not in either public
  integration. These are real Tanium Console concepts (RBAC and Trends), but
  there is no citable public REST v2 contract for any of them to build a
  config type against.
- **Plugin schedules (Tanium Connect).** DOES have a confirmed, documented
  endpoint — `GET /plugin/products/connect/v1/schedules` and
  `.../schedules/{scheduleId}` (mirrored at
  [`tanium-schedules-api-openapi.yml`](https://github.com/api-evangelist/tanium/blob/main/openapi/tanium-schedules-api-openapi.yml))
  — but it is READ-ONLY (list + get by id; no
  `POST`/`PUT`/`DELETE` documented anywhere), a derived sub-resource of a
  `connection` (keyed by `connectionId`) rather than an independently
  authorable object, and lives under Tanium Connect's own plugin base path
  (`/plugin/products/connect/v1/`) — a separately licensed module with its own
  provisioning prerequisites, not the Core Platform REST v2 (`/api/v2/`)
  surface this app targets. Noted alongside the GraphQL API Gateway as a
  future, separately-scoped integration rather than folded into this app.
- Per-endpoint runtime questions/actions (`questions`, `actions`,
  `result_data/*`), secret material (API tokens themselves), and any
  unresolvable FK graph are excluded on the same standing grounds as every
  other Veltrix app.
