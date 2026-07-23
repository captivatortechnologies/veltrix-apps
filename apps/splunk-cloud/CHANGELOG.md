# Changelog

All notable changes to the Splunk Cloud app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.10.10 — 2026-07-23

### Fixed
- Access Servers → View: the modal's inner content now uses the platform theme tokens (`--color-*`) instead of undefined variables, so it themes correctly in **dark mode** (muted labels, borders, the code-block backgrounds, and the danger text). Previously these fell back to fixed light-mode colors. The modal frame already themed via the SDK components; this fixes the hand-styled body.

## 1.10.9 — 2026-07-22

### Added
- Access Servers now have an editable **SSH user** field (default `root`). The View modal's SSH command uses it (`tailscale ssh <ssh-user>@<device>`) instead of wrongly reusing the Splunk connection's API username — the OS login account (root/ubuntu/…) is distinct from the Splunk application user.

## 1.10.8 — 2026-07-22

### Fixed
- Access Servers → View → Ports & services: **Open Web UI** now opens Splunk Web over `http://` (its default), instead of `https://` which failed with an SSL error on instances that don't run Web SSL. The Management API link stays `https://` (always TLS). A note points to switching to https when Web SSL is enabled.

## 1.10.7 — 2026-07-22

### Changed
- Access Servers → View → Ports & services: the **Management API** row now has an **Open ↗** button too (it serves a browsable splunkd interface over the tailnet), in addition to the connection test.

## 1.10.6 — 2026-07-22

### Added
- Access Servers now carry a separate **Web UI port** (default 8000) alongside the management port, editable in the add/edit form.
- Access Servers → View → **Ports & services**: reach both Splunk services over the tailnet. **Splunk Web (UI)** shows an **Open Web UI ↗** button (`https://<tailnet-host>:<web-port>`), and **Management API** keeps the connection test. Endpoints resolve to the server's live tailnet IP once it's online.

## 1.10.5 — 2026-07-22

### Fixed
- Access Servers → View → **Connectivity status** now recognizes a server that has joined the tailnet even when Tailscale rewrote its hostname (it strips a trailing `.local` and turns dots into hyphens, so `splunk-sh1.babong.local` becomes the device `splunk-sh1-babong`). Previously it stayed on "Not connected to the Veltrix network yet" despite the device being online.
- Access Servers → View → **Test connection** now tests the access server's own reachable address (its tailnet IP + management port) instead of the shared connection's endpoint, so it no longer fails with "No endpoint is configured for this connection." when the connection has no standalone host.

### Changed
- The generated **Connect via Tailscale** script now enables Tailscale SSH at join time (`--ssh`), so `tailscale ssh <user>@<device>` works from any tailnet device without a separate setup step.

## 1.10.4 — 2026-07-22

### Changed
- Access Servers → View → **SSH access** now gives the correct command for how the server is reached. For a Veltrix-managed (Tailscale) server it shows `tailscale ssh <user>@<device>` (Tailscale SSH over the tailnet — no separate key needed when Tailscale SSH is enabled) plus an **Open in Tailscale (browser SSH)** link to the device in the Tailscale admin console. For a bring-your-own connection it keeps plain `ssh <user>@<address>`.

## 1.10.3 — 2026-07-22

### Changed
- Access Servers: the **hostname is now clickable** and opens the server's View detail modal (same as the row's View action) — click an item to see its connectivity status, run a connection test, get the Tailscale connect script, and the SSH command.

## 1.10.2 — 2026-07-22

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

## 1.10.1 — 2026-07-22

### Fixed
- Access Servers: the Add/Edit dialog now refetches connections, ZTNA providers,
  and environments each time it opens, so a connection created on the Connections
  page appears in the "Connection" dropdown immediately instead of requiring a
  page refresh (the list was previously loaded only once on page mount).

## 1.10.0 — 2026-07-21

### Added
- **Live ACS-backed pickers for object-reference fields.** Config fields that
  name another live Splunk Cloud object are now searchable pickers instead of
  free-text, backed by the stack's Admin Config Service (ACS) with the JWT the
  app already uses:
  - HEC Tokens **Default Index** (`remote-select`) and **Allowed Indexes**
    (`remote-multiselect`) — search the stack's live indexes (ACS `/indexes`).
  - App Permissions **App** (`remote-select`) — search the stack's installed
    apps, built-in premium apps included (ACS `/permissions/apps`).

  Stored value shapes are unchanged (single index / list of index names / single
  app id), so the existing validate/deploy/drift handlers keep working. Each
  picker falls back to a clear "save the connection first" / "store the ACS JWT"
  message when the connection isn't ready. Role- and user-reference fields
  (which need the Support-gated management REST port) and wildcard-capable fields
  intentionally remain free-text.

## 1.9.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 5 collapsible sections — Data,
  Network & Access, System Settings, Apps, and Access Control — so all 13
  configuration types stay navigable. Sections collapse by default, remember
  whether you left them open, and always expand the one you're currently
  working in.
