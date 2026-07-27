# Changelog

All notable changes to this app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Standing rule:** every version bump ships a CHANGELOG entry. CI compares the
> manifest `version` against the previous commit and fails the build if it
> changed without a matching `## <version>` heading here. Keep `package.json`
> `version` equal to `manifest.yaml` `version`.

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
