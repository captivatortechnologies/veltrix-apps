# Changelog

All notable changes to the Splunk Cloud app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
