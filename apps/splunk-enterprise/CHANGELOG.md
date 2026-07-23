# Changelog

All notable changes to the Splunk Enterprise app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.19.17 — 2026-07-23

### Added
- Deploy now honors the per-role install-directory selections for managed-ZTNA targets: for a Cluster Manager / Deployment Server / Deployer, the built app is placed into the selected staging dir (`etc/manager-apps` / `etc/deployment-apps` / `etc/shcluster/apps`) over the tailnet and the role's bundle push is run (`apply cluster-bundle` / `reload deploy-server` / `apply shcluster-bundle`). `etc/apps` keeps the existing REST install. Requires the platform's remote-exec capability (gated); a non-managed target installs to `etc/apps` only with a note.

## 1.19.16 — 2026-07-23

### Added
- Splunk Apps config → Deployment: selecting **Cluster Manager**, **Deployment Server**, or **Deployer** in Target Server Types now reveals an **install-directory** multi-select for that role — Cluster Manager (`etc/manager-apps` or `etc/apps`), Deployment Server (`etc/deployment-apps` or `etc/apps`), Deployer (`etc/shcluster/apps` or `etc/apps`); both can be chosen. Powered by a new platform `visibleWhen: { includes }` condition that shows a field when a multi-select sibling contains a value.

## 1.19.15 — 2026-07-23

### Changed
- Splunk Apps config → Deployment → **Target Server Types** is now a **multi-select of the known Splunk roles** (indexer, search head, cluster manager, forwarders, deployment server, deployer, license server, SC4S) — the same set as an Access Server's Type — instead of a free-text tag input. Stored value is unchanged (a list of role ids), so existing configs keep working.

## 1.19.14 — 2026-07-23

### Changed
- Add/Edit Access Server: **Type is now multi-select** — a server can be assigned more than one role (e.g. indexer + search head), matching the platform's multi-type component model. At least one type is required.

## 1.19.13 — 2026-07-23

### Added
- Access Servers table now shows an **animated connectivity dot** in the Connectivity (ZTNA) column for Veltrix-managed servers: a pulsing **green** dot when the server is online on the tailnet, a static **red** dot when offline, and an amber "checking" pulse while status loads. Status polls every 30s. (The hostname-matching logic is now shared with the detail modal.)

## 1.19.12 — 2026-07-23

### Fixed
- Dark-mode theming across the rest of the app: **License**, **Activate**, and **Upgrades** pages used the same undefined `--vx-*` variables as the Access Server modal, falling back to fixed light-mode colors (muted text, the over-limit danger text, and the license usage-bar track). Switched them to the real platform tokens (`rgb(var(--color-*))`); the license usage-bar fill keeps the real `--veltrix-app-primary` brand color.

## 1.19.11 — 2026-07-23

### Fixed
- Access Servers → View: the modal's inner content now uses the platform theme tokens (`--color-*`) instead of undefined variables, so it themes correctly in **dark mode** (muted labels, borders, the code-block backgrounds, and the danger text). Previously these fell back to fixed light-mode colors — most visibly the copyable command blocks rendered a bright box on dark backgrounds. The modal frame already themed via the SDK components; this fixes the hand-styled body.

## 1.19.10 — 2026-07-22

### Added
- Access Servers now have an editable **SSH user** field (default `root`). The View modal's SSH command uses it (`tailscale ssh <ssh-user>@<device>`) instead of wrongly reusing the Splunk connection's API username — the OS login account (root/ubuntu/…) is distinct from the Splunk application user.

## 1.19.9 — 2026-07-22

### Fixed
- Access Servers → View → Ports & services: **Open Web UI** now opens Splunk Web over `http://` (its default), instead of `https://` which failed with an SSL error on instances that don't run Web SSL. The Management API link stays `https://` (always TLS). A note points to switching to https when Web SSL is enabled.

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
