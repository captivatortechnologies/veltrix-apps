# Changelog

All notable changes to the Splunk Cloud app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 1.12.0 — 2026-08-05

Dedicated design + build pass on the ACS-native identity migration the
1.11.0 exhaustion pass deliberately deferred (see its "Notes" section below).
Research-first, grounded in Splunk's own `terraform-provider-scp` client
source (not just its docs) — see the README's new **Search-head targeting**
section for full citations.

### Added
- **Roles: opt-in ACS-native transport.** Each role item now carries a
  **Transport** field — `REST` (the default; identical to pre-1.12.0
  behavior) or `ACS` (`/adminconfig/v2/roles` — the same JWT this app already
  requires for everything else, dropping the port-8089-open /
  `search-api`-allow-list prerequisites for that role). See
  `config-types/roles/acsRoles.ts` and `lib/acsIdentity.ts`.
- **Search-head-cluster (SHC) targeting.** A new **Search Head Targets**
  field (ACS transport only) lists search-head-cluster member instance ids
  (e.g. `sh-i-0910d0dfdb9ed913a`) a role should be applied to. ACS role writes
  are **not** replicated across SHC members the way this app's REST transport
  already is (Splunk's own configuration replication) — declaring targets
  here makes this app apply the role to each one explicitly, one write per
  target. Splunk exposes no API to enumerate a stack's SHC members, so this
  is a free-text field, not a live picker (confirmed by searching the entire
  generated ACS OpenAPI client for any "member"/"instance"/"search head"
  surface — none exists).
- `driftDetect` and `healthCheck` now report per-search-head-target results
  for an ACS-transport role with more than one declared target — a role
  present on one cluster member and missing on another is now a visible,
  attributable finding instead of an unchecked blind spot.
- New shared transport module `lib/acsIdentity.ts` (SHC-targeting helpers,
  generic ACS-identity CRUD) and `config-types/roles/acsRoles.ts` (the
  ACS role schema/payload mapping) — see their file-header comments for the
  full source trail.

### Changed
- `roles`' `rollbackData` shape is now transport- and target-aware
  (`{ name, transport, targets: [...] }` instead of the old flat
  `{ name, existed, prior }`). **Fully backward compatible**: `rollback.ts`
  normalizes both shapes through `normalizeRoleRollbackEntry()`, so rolling
  back a deployment made by the pre-1.12.0 code works exactly as before —
  no data migration needed.
- README: `roles` moves from a single-transport "Managed (REST)" listing to
  documenting BOTH transports; the long-standing "Future work" ACS-identity-
  migration item is resolved (for roles) and removed.

### Potentially breaking (opt-in only — READ before switching an existing role to ACS)
- **Default behavior is unchanged**: an existing canvas with no `transport`
  field deploys exactly as it did in 1.11.0 and earlier (REST, whole
  cluster). Nothing breaks by upgrading alone.
- **Switching `transport` to `acs` on a role IS a real behavior change you
  opt into**, not a transparent transport swap: ACS does not replicate to
  other search-head-cluster members, and switching does NOT retroactively
  move a role already created via REST — it only changes where FUTURE
  deploys of that role land. On a clustered stack, deploying with `acs` and
  an empty **Search Head Targets** list reaches exactly one search head
  (whichever ACS's own default routes to), which most operators will not
  expect coming from REST's whole-cluster behavior. `validate` warns loudly
  (`untargeted_acs_write`) when this is the case; read the warning before
  ignoring it.

### Notes — `users` stays REST-only (evaluated, not skipped)
- ACS's native `/adminconfig/v2/users` endpoint (also confirmed via
  `terraform-provider-scp`) was evaluated for the same treatment and
  deliberately NOT adopted this release: its schema has **no timezone
  field**, and this type manages `tz` — a genuine feature gap, not a
  transport nicety, and this app does not silently drop a declared field on
  write anywhere else. Combined with the same SHC non-replication caveat
  roles' ACS transport carries, and the fact that `authentication-tokens`
  and `sso` stay REST-only regardless (no ACS equivalent exists for either),
  migrating `users` would keep every REST prerequisite in place for a
  typical deployment anyway — a materially smaller win than roles, for a
  real regression. See the "WHY THIS TYPE STAYS REST-ONLY" note in
  `config-types/users/validate.ts`. Revisit if ACS ever adds a timezone
  attribute.

## 1.11.0 — 2026-08-05

Research-first exhaustion pass against the current ACS API surface (endpoint
reference + Splunk's official `terraform-provider-scp`), closing every
genuinely untapped, declarative gap found. See the README's new **Coverage**
section for the full managed/excluded breakdown and sources.

### Added
- **IPv6 Allow Lists** (`ip-allowlists-v6`) — the IPv4 allow-lists type's
  documented v1 limitation ("IPv4 allow lists only") is resolved. A separate
  ACS resource from the v4 type (`/access/{feature}/ipallowlists-v6`), same
  seven features. Implements the documented ACS quirk that a reconcile cannot
  remove every live subnet from a feature in one request — one is held back
  and reported so a follow-up deploy finishes the removal.
- **IPv6 Outbound Ports** (`outbound-ports-v6`) — the IPv6 counterpart to
  Outbound Ports (`/access/outbound-ports-v6`), same reconcile model as v4.
- **Splunkbase Apps** (`splunkbase-apps`) — install, upgrade and uninstall
  *published* Splunkbase apps by catalog id via ACS
  (`POST/PATCH/GET/DELETE .../apps/victoria?splunkbase=true`), separate from
  the existing "Splunk Apps" type (which builds and AppInspect-vets *private*
  apps from authored files). Closes this app's own long-standing "Future work"
  backlog item. Needs a Splunkbase session id in addition to the ACS token —
  reuses the same splunk.com username/password credential fields the private
  app type already asks for (see `lib/splunkbase.ts`).
- **Roles: Maximum Search Age** (`srchTimeEarliest`) — the one standard
  Splunk role attribute this type was missing (distinct from the existing
  Maximum Search Time Window / `srchTimeWin`, which limits a search's span
  rather than how far back it may start).
- **Roles: live Capabilities picker** — the Capabilities field is now a
  searchable `remote-multiselect` backed by ACS's own grantable-capability
  list (`GET /adminconfig/v2/capabilities?grantableOnly=true`), instead of
  free text. This is a pure ACS lookup, so it works even though roles
  themselves still deploy over the REST API (ACS cannot manage the role
  object itself) — no new prerequisites.
- **README Coverage section** documenting every managed vs. excluded ACS/REST
  surface with sourced reasons, and the ACS-vs-REST / Cloud-restriction
  boundary this app operates within.

### Changed
- Manifest/README description updated to name IPv6 and Splunkbase coverage.

### Notes (not implemented — flagged for a dedicated follow-up)
- Splunk's `terraform-provider-scp` shows ACS has gained NATIVE identity
  management (`/adminconfig/v2/roles`, `/adminconfig/v2/users`,
  `/adminconfig/v2/capabilities`) since this app's `roles`/`users` types were
  built on "ACS cannot manage identity." Migrating is deliberately **out of
  scope for this release**: it is a breaking transport change to two already-
  shipped, working config types, and ACS role/user writes are documented as
  NOT automatically replicated across search-head-cluster members (they
  require explicit search-head targeting) — a real design question, not a
  drop-in swap. See README Coverage for detail.

## 1.10.12 — 2026-07-23

### Changed
- Add/Edit Access Server: **Type is now multi-select** — a server can be assigned more than one role (e.g. indexer + search head), matching the platform's multi-type component model. At least one type is required.

## 1.10.11 — 2026-07-23

### Added
- Access Servers table now shows an **animated connectivity dot** in the Connectivity (ZTNA) column for Veltrix-managed servers: a pulsing **green** dot when the server is online on the tailnet, a static **red** dot when offline, and an amber "checking" pulse while status loads. Status polls every 30s. (The hostname-matching logic is now shared with the detail modal.)

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
