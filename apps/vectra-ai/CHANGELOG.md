# Changelog

All notable changes to the Vectra AI app are documented here.

## 0.3.0 — 2026-08-04

Five new configuration types, exhausting the meaningfully declarative,
config-as-code write surface of the Vectra Detect API (v2.5, token auth) —
re-verified end-to-end against Vectra's official Python client
(`vectra_api_tools`, `modules/vectra.py`, all client versions through
`VectraClientV2_5`).

### Added

- **Internal Networks (`internal-networks`)** — the brain-wide internal /
  excluded / dropped subnet configuration, over `GET`/`POST
  /settings/internal_network`. A full-replace singleton (`repeatable: false`,
  like the `_template`/Cisco Duo account-settings pattern) — the declared item
  is the COMPLETE desired state; anything present on the brain but not
  declared is removed on deploy. **Flagged**: the read and write bodies use
  different key names for the same three lists (`included_subnets` /
  `excluded_subnets` / `dropped_subnets` on read vs `include` / `exclude` /
  `drop` on write) — confirmed from the official client, not yet confirmed
  against a live brain's raw response.
- **Match Enablement (`match-enablement`)** — enable/disable Vectra Match
  (Suricata-based Suspect Protocol Activity detections, added in Detect
  v2.5; requires a Match license) per sensor device, over `GET`/`POST
  /vectra-match/enablement`. A boolean toggle per `device_serial` — no
  create/delete, only PATCH-in-place semantics via POST.
- **Match Ruleset Assignment (`match-assignments`)** — assigns an existing
  Vectra Match custom ruleset (identified by UUID) to sensor devices, over
  `GET`/`POST`/`DELETE /vectra-match/assignment`. Reconciled as a set per
  ruleset UUID: devices declared but not live are added in one bulk POST;
  devices live but not declared are removed one `DELETE` at a time (the wire
  API's own asymmetry — bulk assign, single-device unassign). Ruleset
  **content** (the Suricata rules file itself) is intentionally NOT managed —
  see Coverage below.
- **Assignment Outcomes (`assignment-outcomes`)** — the custom resolution
  labels analysts choose when closing out a detection assignment (e.g.
  "Confirmed Phishing" → `malicious_true_positive`), full CRUD over
  `/assignment_outcomes` (added in API v2.2+), upsert by `title`, with the
  same validate / deploy / rollback (restore prior or delete created) /
  health-check / drift-detect / status lifecycle as Triage Rules and Groups.
- **Entity Tags (`entity-tags`)** — the tag set on a Vectra host or account,
  identified by its numeric entity id (the same kind of id Groups' host-type
  membership already declares directly), over `GET`/`PATCH
  /tagging/{host|account}/{id}`. Full replace per entity. One config type
  covers both host and account tags (an `entity_type` field selects the API
  path) rather than duplicating two near-identical config types. Detection
  tags are intentionally NOT managed — a detection is a single, short-lived
  event instance, not a durable entity worth declaring desired state for.
- Registered `internal-networks`, `match-enablement`, `match-assignments`,
  `assignment-outcomes` and `entity-tags` app permissions; every new
  configuration type declares a sidebar `group` ("Network Coverage" for the
  Vectra Match + internal-networks trio, "Detection Tuning" for assignment
  outcomes alongside Triage Rules, "Scoping" for entity tags alongside
  Groups/Proxies).

### Fixed

- **Proxies rollback hardened against a known Vectra client bug (APP-15864).**
  Vectra's own Python client carries an open caution on `update_proxy`: a
  `PATCH` update can change the proxy's resource id as a side effect (and an
  invalid id then surfaces as an HTTP 500, not a 404). `rollback.ts` now
  re-resolves a proxy's CURRENT id by its (stable) address before restoring it,
  instead of trusting the id captured at deploy time — falling back to the
  captured id only when the live re-lookup itself fails.

### Re-evaluated (prior drops + flags, re-verified against the official v2.5 client)

- **Groups `account` type is now CONFIRMED, not just offered.** The v2.5
  client's operative `create_group`/`update_group` (defined on
  `VectraClientV2_4` — `VectraClientV2_5` does not override them) validates
  `type` ∈ `{account, domain, host, ip}`; an earlier, superseded
  `VectraBaseClient` implementation restricted to `{host, domain, ip}`, but a
  v2.5 client never resolves to that method. `_shared.ts` and `canvas.yaml`
  updated from "unverified" to confirmed.
- **`threatFeeds` re-confirmed NOT upsertable** even in the current v2.5
  client: `create_feed` (`POST`) / `delete_feed` (`DELETE`) /
  `post_stix_file` (multipart) exist; no update/PATCH method was added.
  Dropped, as in 0.2.0.
- **`users` re-confirmed NOT upsertable**: `update_user` (`PATCH`,
  `account_type` + `authentication_profile` only) is the only write method;
  still no `create_user` at any client version. Dropped, as in 0.2.0.
- **Considered and dropped, newly identified this pass:**
  - *AWS External Connector* (`POST /settings/aws_connectors`) — create-only
    (no update, no delete) AND embeds a raw AWS secret access key in the
    request body. Not cleanly upsertable/rollback-able for the same reason as
    `threatFeeds`/`users`, and security-sensitive control-plane bootstrap in
    the same spirit as credential/API-key administration excluded elsewhere in
    this catalog (see e.g. Cisco Meraki's Coverage).
  - *Sensor registration token* (`GET`/`POST`/`DELETE /sensor_token`) — a
    single, 24h-lived bootstrap secret for registering new sensors, not a
    durable declared resource.
  - *Vectra Match custom ruleset content* (`POST`/`DELETE
    /vectra-match/rules`, multipart file upload) — no update-in-place, and no
    "list all rulesets" capability exists in the official client to safely
    detect an existing ruleset by identity before creating (only a
    uuid-scoped lookup). Upserting would risk creating duplicate rulesets on
    every deploy. The adjacent, fully enumerable pieces (device enablement,
    device↔ruleset assignment) ARE built — see Added above; ruleset content
    itself is managed through the Vectra UI or Vectra's own
    `vectra_match_workflow` tooling.
  - *Assignment lifecycle* (`create_account_assignment` /
    `create_host_assignment` / `update_assignment` / `delete_assignment` /
    `set_assignment_resolved`) — per-detection analyst work assignment and
    resolution is operational incident-response workflow state, not durable
    infrastructure-as-code (parallel to Meraki's exclusion of imperative Live
    Tools/action endpoints). `assignment_outcomes` (the small, static
    resolution-label CATALOG referenced by that workflow) is built instead —
    see Added above.
  - *Host / account / detection notes* (`PATCH` on `/hosts/{id}`,
    `/accounts/{id}` via `get_account_by_id`, and detection notes) — free-text
    incident annotation, not stable declarative desired state worth
    drift-correcting back to a canvas value. Tags (a stable classification
    concern) are built instead — see Entity Tags above.
  - *Roles* — no distinct Roles CRUD resource exists; `update_user`'s
    `account_type`/`authentication_profile` is the only identity-adjacent
    write, already covered by the `users` drop above.
  - *Detection tags* (`/tagging/detection/{id}`) — a detection is a
    single, short-lived event instance; only host and account tags (covered
    by Entity Tags) are durable enough to be worth declaring desired state
    for.

> All new endpoint shapes are modeled from Vectra's official
> `vectra_api_tools` Python client (`VectraClientV2_5` and its full ancestor
> chain) and should be verified against a live Vectra brain, consistent with
> the flags already carried by Triage Rules / Groups / Proxies.

## 0.2.0 — 2026-08-01

Two new configuration types over the Vectra Detect REST API (v2.5, 443).

- **Groups** config type — create / edit / delete Vectra groups (named sets of
  hosts, IPs, domains or accounts used to scope detection tuning), over
  `/api/v2.5/groups`, with validate / deploy (upsert by group name) / rollback
  (restore prior or delete created) / health-check / drift-detect / status.
  Only static membership is managed; a group's `type` is set at create time.
- **Proxies** config type — create / edit / delete Vectra proxy IPs (internal
  addresses Vectra treats as proxies so detections are attributed to the real
  client behind them), over `/api/v2.5/proxies`, with the same pipeline lifecycle
  (upsert by proxy address).
- Registered `groups` and `proxies` app permissions; both surface as Overview
  cards via the `/meta` route (no new sidebar navigation).

> Endpoint shapes follow Vectra's official `vectra_api_tools` v2 (Detect) client
> and should be verified against a live Vectra brain. FLAGGED for verification:
> the official v2 API validates group `type` as host / domain / ip — the `account`
> option is offered but unverified; dynamic regex group membership (`rules`) has no
> documented v2 object shape and is out of scope (static members only); a group's
> `type` is immutable on update (v2 PATCH carries name/description/members); and the
> proxies list-envelope shape (`proxies` vs DRF `results`, flattened vs nested) is
> read defensively. Considered but dropped: `users` (v2 exposes PATCH/update only —
> no create, so not cleanly upsertable) and `threatFeeds` (create + delete only, no
> PATCH — no clean in-place update/rollback).

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Triage Rules** config type — create / edit / delete Vectra triage rules
  (description, detection category + type, whitelist or triage category, and
  host/network scope) over the Vectra Detect REST API (v2.5, 443), with
  validate / deploy (upsert by rule description) / rollback (restore prior or
  delete created) / health-check / drift-detect / status.
- **Connectivity test** against the Vectra Detect REST API
  (`GET /api/v2.5/rules?page_size=1`, HTTPS, self-signed tolerated) using a
  Vectra API token (`Authorization: Token <token>`).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API
  token → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Vectra brain; saving a connection registers
  `vectra-brain` as a deploy target).

> Vectra Detect API paths follow the v2.5 REST API and should be verified against
> a live Vectra brain. The exact `detection_category` enum values/casing and valid
> `detection` (detection type) names are Vectra-defined — only `LATERAL MOVEMENT`
> is confirmed from Vectra's official API docs. The newer Vectra platform v3
> (RUX / Respond) uses OAuth2 client-credentials (Bearer) and is noted for a future
> version. TLS verification is off by default (self-signed on-prem brains) and
> configurable via the `verify_tls` setting.
