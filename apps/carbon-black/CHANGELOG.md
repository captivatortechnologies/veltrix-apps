# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

## 0.5.0 — 2026-07-26

### Added
- **Data Forwarders** configuration type — manage Carbon Black Cloud data
  forwarders (event streams shipped to AWS S3 / Azure Blob / GCS) as code, with
  the full pipeline handler set. Forwarders are matched by name (stored id
  preferred so a rename updates in place); the name, enabled flag and destination
  bucket update via PUT, while `type` and `destination` are immutable and a change
  to either forces delete+recreate. The core forwarder object is managed; the
  optional endpoint.event filters sub-resource is out of scope.
- **Asset Groups** configuration type — manage Carbon Black Cloud asset groups
  (dynamic, query-based device grouping with optional policy assignment) as code,
  with the full pipeline handler set. Groups are matched by name, created/updated
  via POST/PUT and reconcile only deletes groups this app created. Dynamic groups
  re-evaluate asynchronously, so drift is not reported while a group is UPDATING;
  static membership is out of scope.
- **Device Control Approvals** configuration type — manage Carbon Black Cloud USB
  device-control approvals (allow-list entries) as code, with the full pipeline
  handler set. Approvals are matched by their device-selector natural key
  (vendor id + product id + serial number), created in bulk (the CBC create is
  bulk-only) and listed via a `_search`; reconcile only deletes approvals this
  app created.
- **Device Control Blocks** configuration type — manage Carbon Black Cloud
  per-policy USB enforcement (write/execute toggles for approved devices) as code,
  with the full pipeline handler set. A block is a singleton per policy; the app
  resolves the policy by name, upserts one block per policy (bulk create / PUT
  update) and reconcile only deletes blocks this app created. The policy is never
  deleted.
- **Watchlist Reports** configuration type — manage Carbon Black Cloud shared
  watchlist reports (titled IOC groups referenceable by watchlists) as code, with
  the full pipeline handler set. The shared reports store has no list-all endpoint
  and server-assigns each id, so the app reconciles by the report id it stored per
  canvas item (rename-safe), managing only reports it created. A report must carry
  at least one IOC; setting a link makes it non-editable in the console (surfaced
  as a warning).
- **Policy Rule Configs (Core Prevention)** configuration type — manage the
  Carbon Black Cloud core-prevention rule-config assignment (BLOCK / REPORT) per
  named policy as code, with the full pipeline handler set. Rule configs are
  platform-managed objects nested under a policy: the app resolves the policy by
  name, PATCHes the chosen mode (and optional exclusions) onto each core-prevention
  config, and resets the category to its default (DELETE) when a policy is removed
  from the canvas. Scoped to the `core_prevention` category (the one with a cleanly
  grounded contract); bypass / data_collection / host_based_firewall are out of
  scope. The policy is never deleted.
- Base-path getters and a generic `_search` pager (`searchAllAt`) in the CBC API
  client, reused across the new config types.

## 0.4.0 — 2026-07-26

### Added
- **Feed Reports** configuration type — manage the titled IOC reports nested
  inside a private threat feed as code, with the full pipeline handler set. Each
  report targets a parent feed by name (resolved to a feed id, reusing the Threat
  Feeds resolution), is matched within that feed by a stable caller-supplied
  report id (rename-safe) and carries a single equality `iocs_v2` entry. Deploy
  lists a feed's reports, upserts the declared ones via the replace-reports POST
  while preserving reports it does not own, and reconcile only deletes reports
  this app created; per-report `PUT`/`DELETE` back out a rollback. A report must
  carry at least one IOC (the CBC feed manager rejects an empty report).
- **Policies** configuration type — manage Carbon Black Cloud endpoint policies
  as code via the Policy Service v1 API, with the full pipeline handler set.
  Name, description and priority level (`LOW`/`MEDIUM`/`HIGH`/`MISSION_CRITICAL`)
  are managed as first-class fields; the substantive policy body (av_settings,
  rules, sensor_settings, ...) is supplied as a validated JSON textarea. Policies
  are matched by name with the stored id preferred so a rename updates in place;
  deploy creates via POST, updates via PUT, and reconcile only deletes non-system
  policies this app created. Drift is scoped to the managed priority level and
  description (the policy body is server-normalized).

## 0.3.0 — 2026-07-26

### Added
- **Watchlists** configuration type — manage Carbon Black Cloud watchlists that
  subscribe to a threat feed as code, with the full pipeline handler set.
  Watchlists are modelled as feed subscriptions (`classifier = { key: "feed_id",
  value: <feedId> }`, no `report_ids`) and matched by name, with the stored id
  preferred so a rename updates in place. Deploy creates via POST, updates via
  PUT, and reconcile only deletes watchlists this app created. Invariant: alerts
  may be enabled only when tags are enabled.

## 0.2.0 — 2026-07-26

### Added
- **Threat Feeds** configuration type — manage Carbon Black Cloud private threat
  feeds (a set of IOCs — file hashes, domains, or IPs) as code, with the full
  pipeline handler set. Feeds are matched by name; the app manages the feed
  metadata plus a single managed report whose IOCs are reconciled to exactly the
  declared set; feed metadata updates via PUT /feedinfo; reconcile only deletes
  feeds this app created. (A feed is inert until a Watchlist subscribes to it.)
- `PUT` support in the CBC API client.

## 0.1.0 — 2026-07-26

### Added
- Initial release. VMware Carbon Black Cloud API client (`lib/carbonblack.ts`)
  with `X-Auth-Token: secret/id` auth, org-scoped paths, `_search` (start/rows)
  pagination and 429 Retry-After backoff.
- **Reputation Overrides** configuration type — manage allow/ban entries by
  SHA256 hash, signing certificate, or IT-tool path as code, with the full
  pipeline handler set: validate, deploy, rollback, drift detection, health check
  and status. Carbon Black has no update API, so overrides are matched by their
  natural key (type + hash/cert/path) and a change is applied as delete +
  recreate; the original pre-management state is carried forward so rollback can
  restore it, and reconcile only deletes overrides this app created.
- Client UI — Overview, Setup Guide and Connections pages built on
  `@veltrixsecops/app-sdk/ui`; Connections uses the shared `<ConnectionsManager>`
  configured for the API ID + secret credential and the `carbon-black` deploy
  target.
- Connection test (`handlers/testConnection.ts`) running a minimal
  reputation-override search.
