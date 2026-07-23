# Changelog

All notable changes to the Splunk Enterprise app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.19.8 — 2026-07-22

### Changed
- Access Servers → View → Ports & services: the **Management API (8089)** row now has an **Open ↗** button too (it serves a browsable splunkd interface over the tailnet), in addition to the connection test.

## 1.19.7 — 2026-07-22

### Added
- Access Servers now carry a separate **Web UI port** (default 8000) alongside the management port (8089), editable in the add/edit form.
- Access Servers → View → **Ports & services**: reach both Splunk services over the tailnet. **Splunk Web (UI)** shows an **Open Web UI ↗** button (`https://<tailnet-host>:<web-port>`), and **Management API** keeps the connection test. Endpoints resolve to the server's live tailnet IP once it's online.

## 1.19.6 — 2026-07-22

### Fixed
- Access Servers → View → **Connectivity status** now recognizes a server that has joined the tailnet even when Tailscale rewrote its hostname (it strips a trailing `.local` and turns dots into hyphens, so `splunk-sh1.babong.local` becomes the device `splunk-sh1-babong`). Previously it stayed on "Not connected to the Veltrix network yet" despite the device being online.
- Access Servers → View → **Test connection** now tests the access server's own reachable address (its tailnet IP + management port) instead of the shared connection's endpoint, so it no longer fails with "No endpoint is configured for this connection." when the connection has no standalone host.

### Changed
- The generated **Connect via Tailscale** script now enables Tailscale SSH at join time (`--ssh`), so `tailscale ssh <user>@<device>` works from any tailnet device without a separate setup step.

## 1.19.5 — 2026-07-22

### Changed
- Access Servers → View → **SSH access** now gives the correct command for how the server is reached. For a Veltrix-managed (Tailscale) server it shows `tailscale ssh <user>@<device>` (Tailscale SSH over the tailnet — no separate key needed when Tailscale SSH is enabled) plus an **Open in Tailscale (browser SSH)** link to the device in the Tailscale admin console. For a bring-your-own connection it keeps plain `ssh <user>@<address>`.

## 1.19.4 — 2026-07-22

### Changed
- Access Servers: the **hostname is now clickable** and opens the server's View detail modal (same as the row's View action) — click an item to see its connectivity status, run a connection test, get the Tailscale connect script, and the SSH command.

## 1.19.3 — 2026-07-22

### Added
- **Access Servers — per-server "View" detail modal.** Each row now has a View
  action alongside Edit/Remove that opens a read-only detail view with four
  sections: (1) **Server summary** — hostname, management port, type,
  environment, domains, IP ranges, the assigned Connection name, and the ZTNA
  provider name; (2) **Connectivity status** — the server's ZTNA provider and
  its live tailnet device status (Online/Offline, tailnet IP, last seen), or
  "Not connected to the Veltrix network yet" when no device matches; (3)
  **Connection test** — a Test button that runs this app's connectivity test
  handler against the server's assigned Connection and shows the ok/fail
  result; (4) **Connect via Tailscale** — shown only when the server's ZTNA
  provider is the Veltrix-managed one — a "Generate connect script" /
  "Regenerate" button that mints a fresh enrollment and displays the
  copyable install command to run on the server, plus a copyable **SSH
  access** command (using the tailnet IP when the device is online, else the
  hostname, with the assigned Connection's username when available).

## 1.19.2 — 2026-07-22

### Changed
- Sidebar layout: moved **BYOL Infrastructure** and **Upgrades** into the
  Configurations group (alongside HEC Tokens / Splunk Apps) and **License** into
  the Settings group (with Access Servers / Connections), so the top Pages group
  stays to Overview / Setup Guide / Pipeline.

## 1.19.1 — 2026-07-22

### Fixed
- Access Servers: the Add/Edit dialog now refetches connections, ZTNA providers,
  and environments each time it opens, so a connection created on the Connections
  page appears in the "Connection" dropdown immediately instead of requiring a
  page refresh (the list was previously loaded only once on page mount).

## 1.19.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  Splunk **App** or **HEC Token**, the app now resolves WHO last manually changed
  the object and WHEN, and attaches it to each drift diff (rendered by the
  platform; `—` when unknown). Attribution reads Splunk's internal `_audit`
  index via a single BLOCKING search export — `POST
  /services/search/v2/jobs/export` (falling back to
  `/services/search/jobs/export` on older splunkd) — running `search
  index=_audit action=* object="<name>" | head 20 | table _time user action
  object` over the last 7 days, keyed on the drifted object's NAME (Splunk audit
  keys on object name, not an id). Each result row maps to `user` (actor),
  `_time` (when), and `action` (event type).
- The resolver prefers a change-type action (`edit`/`create`/`delete`/…) and
  otherwise falls back to the most recent human event. Veltrix's own deploys are
  excluded by the connection's service-account username, and Splunk internal
  principals (e.g. `splunk-system-user`) are never attributed. Attribution is
  STRICTLY best-effort with a short timeout: any error, empty result, or
  no usable human event leaves the diff unattributed and never fails a drift
  check. Only objects that actually drifted are queried, once each.

## 1.18.0 — 2026-07-21

### Added
- **Live index pickers for HEC tokens.** The HEC Token config type's **Default
  Index** and **Allowed Indexes** fields are now searchable pickers backed by the
  connected instance's live indexes (via `GET /services/data/indexes`,
  `datatype=all`) instead of free-text. Default Index is a single-select
  (`remote-select`); Allowed Indexes is a multi-select (`remote-multiselect`).
  The stored value shape is unchanged — Default Index still stores one index
  name, Allowed Indexes still stores a list of names — so the existing
  validate/deploy/drift handlers keep working. Falls back to a clear "save the
  connection first" message when no deploy target is registered yet.
