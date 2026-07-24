# Changelog

All notable changes to the Splunk Enterprise app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.19.34 — 2026-07-24

### Changed
- **HEC Tokens can target search heads, not just indexers/heavy-forwarders.** HEC runs on any full Splunk instance with the http input enabled — most commonly a **search head**. The config type previously restricted its targets to `[indexer, heavy-forwarder]`, which excluded search heads from the default target set and the picker's default host resolution. It now allows `[search-head, indexer, heavy-forwarder]`; the operator chooses per-config with **Target Server Types** (e.g. scope to `search-head`). The pre-flight index message is now role-neutral ("scope Target Server Types to a server that has it") instead of steering toward an indexer. The pre-flight check itself is unchanged — an HEC token's index must still exist on whichever server it targets (splunkd validates the index against that instance's local index list), so on a search head pick an index that server actually has.

## 1.19.33 — 2026-07-24

### Added
- **HEC Token deploy pre-flight index check.** Before creating any token, the deploy now fetches the target server's live index list (`data/indexes`) and verifies every index a token routes to (Default Index + Allowed Indexes) actually exists there. If one doesn't, it fails fast — before writing anything — with a precise, per-host message, e.g. *"Index 'main' does not exist on splunk-sh1.babong.local (available: _configtracker, _dsappevent). Pick a valid index for this server, or scope Target Server Types to an indexer that has it."* This replaces the raw splunkd 400 (`The specified index main is not valid…`) that previously surfaced mid-loop and could leave a partial deploy, and it makes the fix obvious: HEC tokens with a data index belong on indexers/heavy-forwarders, so scope **Target Server Types** to `indexer`. Best-effort: if the index list can't be read (transient/auth), the check is skipped and the real deploy surfaces the underlying error rather than blocking. Covered by new tests.

## 1.19.32 — 2026-07-24

### Fixed
- **HEC Token deploy/rollback/health/drift now reach managed-ZTNA servers.** Deploying HEC Tokens to a server reachable only over the managed tailnet failed with `Deploy failed on <host>: Missing credential or connectivity for HEC token deployment`. A managed-ZTNA host has no direct connectivity record — it is reached through the connectivity provider's tailnet device address — but the HEC handlers required a direct `connectivity` and built the splunkd URL without the provider. All four network handlers now accept **either** direct connectivity **or** a connectivity provider, and build the URL via the shared `buildSplunkUrl` (tailnet `deviceAddress` + self-signed cert via `splunkFetch`), matching the Splunk Apps / options-picker paths. The guard also distinguishes a missing credential from missing connectivity so the failure message is precise.

## 1.19.31 — 2026-07-24

### Fixed
- **Live index pickers (HEC Token Default/Allowed Indexes) now reach managed-ZTNA servers.** The options provider built the splunkd URL from the component's raw `.local` hostname, which never resolves from the platform (`Failed to list Splunk options: getaddrinfo EAI_AGAIN splunk-sh1.babong.local`). It now uses the shared `buildSplunkUrl` — the connectivity provider's tailnet device address — so the picker reaches the instance over the managed tailnet (and accepts its self-signed cert via `splunkFetch`). The platform resolves + passes the connectivity provider to the options context, and can scope the query host by **Target Server Types** (role) when the config surface provides them.

## 1.19.30 — 2026-07-23

### Fixed
- **Deployer bundle push now passes the required `-target`.** `apply shcluster-bundle` MUST be run as `$SPLUNK_HOME/bin/splunk apply shcluster-bundle -target https://<member>:8089` — the Deployer pushes the bundle to one search head cluster member. The deploy (and rollback re-apply) previously ran it with no `-target`, which fails. It now resolves a **search-head member** (a registered server with the `search-head` role, preferring one other than the Deployer itself) and targets its internal `hostname:8089`; a clear error is raised if no search-head server is registered. The Cluster Manager (`apply cluster-bundle`) and Deployment Server (`reload deploy-server`) pushes need no target and were already correct. All three carry the Splunk admin `-auth`. Confirms the per-staging-dir bundle contract: `etc/deployment-apps → reload deploy-server`, `etc/manager-apps → apply cluster-bundle`, `etc/shcluster/apps → apply shcluster-bundle -target …`.

## 1.19.29 — 2026-07-23

### Fixed
- **Content drift no longer false-alarms on splunkd's own `app.conf` bookkeeping.** When Splunk installs an app from a package it rewrites `default/app.conf`, adding `[install] install_source_checksum` (and can add other keys) — which changed the file hash and showed up as "drift" with no meaningful difference. `.conf`/`.meta` files are now compared **key-by-key on the stanza keys we shipped** (values must match); extra keys splunkd or an app legitimately add are ignored, and a changed shipped value is reported as a precise per-key diff instead of a whole-file diff. Non-`.conf` files (scripts, lookups) keep the exact-hash comparison. The managed and REST paths now share this comparison.

## 1.19.28 — 2026-07-23

### Added
- **Content drift for inline Splunk apps — hash every shipped file and show the diff.** Drift detection now goes beyond app state (installed / enabled / version / label): for an app authored inline, it compares the SHA-256 of every file the deploy shipped against the live app and reports:
  - a **modified** file — and over managed ZTNA it **pulls the live content and surfaces both sides so the actual diff is visible**;
  - a **missing** shipped file;
  - an **unexpected** file added under the app's `default/` (the folder the app owns). Extra files elsewhere (`local/` overrides, Splunk runtime files) are ignored to avoid noise.
- Two paths: **managed-ZTNA** targets are hashed over the tailnet (a new read-only `hashTree` + `readFile` remote capability); **non-managed** targets compare the effective merged `.conf` values via REST (`configs/conf-<file>`), flagging only the stanza keys we shipped.

### Fixed
- Drift now **reaches managed-ZTNA servers**: it no longer hard-requires a separate connectivity record, resolves the tailnet device address, and **scopes by Target Server Types** (matching deploy + health-check). Previously drift on a managed server silently reported "no drift" because it couldn't reach the `.local` hostname.

## 1.19.27 — 2026-07-23

### Changed
- **Splunk Apps validation now catches two package-source footguns at author time** instead of a cryptic splunkd `500` on deploy: (1) a **Local** source whose reference is a bare name rather than an absolute file path is now an error (splunkd would fail to extract it — "No such file or directory"), and (2) when a config declares **authored App Contents but the source is not "Author files inline"**, validation warns that those files will be ignored and suggests switching to inline (authored `.conf` files ship only via an inline build).

## 1.19.26 — 2026-07-23

### Fixed
- **Inline app install over managed ZTNA now uses the install-by-path method splunkd accepts.** splunkd's `POST apps/local` does not parse a **multipart** `.spl` upload — it URL-decodes the body regardless of the multipart `Content-Type`, so a binary package intermittently fails with `400 Unparsable URI-encoded request data` (even canonical `curl -F` fails the same way). For a managed-ZTNA target the deploy now **stages the built `.spl` on the Splunk box over the tailnet** (`$SPLUNK_HOME/var/run/veltrix/<app>.spl`, via the platform's new `ctx.remote.putFile`) and installs it with the documented **form-encoded** `name=<server-local-path>&filename=1&explicit_appname=<app>` call. Direct (non-managed) targets keep the multipart upload. Requires the platform's remote-exec capability (gated).

## 1.19.25 — 2026-07-23

### Fixed
- App **package (.spl) upload** now sends an explicit `Content-Length`. After the 1.19.24 switch to `node:https`, a body with no `Content-Length` was streamed with `Transfer-Encoding: chunked`, which splunkd's multipart parser rejects with `400 Unparsable URI-encoded request data` — so a deploy reached Splunk (cert fix worked) but failed on the first app install. `splunkFetch` now frames every body (binary or string) with its exact byte length, matching what `fetch` did. Added a transport test that hits a real local HTTP server to pin the framing (Content-Length set, never chunked, bytes preserved).

## 1.19.24 — 2026-07-23

### Fixed
- Splunk's management API (8089) serves a **self-signed certificate** by default, which Node's global `fetch` rejects with an opaque "fetch failed" — this broke every deploy/health-check/drift call to a managed-ZTNA server (the connection already rides the WireGuard-encrypted tailnet, so TLS verification here is redundant). All Splunk REST traffic now goes through a single `splunkFetch` helper (node:https, accepts the self-signed cert) instead of global `fetch`. Fixes "Deploy failed on &lt;server&gt;: … fetch failed". Covers deploy, both health checks, both drift detectors, the live-license reader, and audit (drift-attribution) searches.

## 1.19.23 — 2026-07-23

### Fixed
- Post-deploy **health check** now scopes by Target Server Types (a server outside the selected roles reports healthy — nothing to check, instead of failing) and reaches managed-ZTNA servers over the tailnet. Fixes a deploy failing with "Health check failed on <indexer> (score: 0)" when the config targeted only Deployment Servers.

## 1.19.22 — 2026-07-23

### Fixed
- Deploy now **scopes by Target Server Types**: an app deploys ONLY to servers whose role is selected (e.g. Deployment Server → only your deployment servers), instead of every Splunk box the config type can reach. Previously a Deployment-Server-targeted app also tried to install on indexers/search heads and failed.
- Deploy/rollback now reach **managed-ZTNA servers over the tailnet** (the connectivity provider's device address) instead of the unresolvable `.local` hostname, and no longer hard-require a separate connectivity record. Fixes "Missing credential or connectivity" on managed servers.

## 1.19.21 — 2026-07-23

### Changed
- Splunk Apps config → Deployment: **every** selected Target Server Type now shows an install-directory picker. Search Head, Heavy Forwarder, Universal Forwarder, and License Server offer `etc/apps` (their only install location, pre-selected), so the form uniformly shows where each selected role installs — alongside the multi-option pickers for Cluster Manager, Indexer, Deployment Server, and Deployer.

## 1.19.20 — 2026-07-23

### Added
- Splunk Apps config → Deployment: selecting **Indexer** in Target Server Types now reveals an install-directory picker too — `etc/peer-apps` (cluster peer bundle location) or `etc/apps` (local). Placement only, with no bundle push (etc/peer-apps is normally managed by the Cluster Manager). This joins the Cluster Manager / Deployment Server / Deployer pickers — every role with a real directory choice now has one.

## 1.19.19 — 2026-07-23

### Added
- Access Servers now have a **Splunk home** field (`$SPLUNK_HOME`, e.g. `/opt/splunk` or `/opt/splunkforwarder`), shown in the add/edit form and the View modal. Staging-dir deploys use it to build install paths; when left blank the platform auto-detects it (a non-login SSH shell rarely exports `$SPLUNK_HOME`, so it probes for a full Splunk vs a universal forwarder install).

## 1.19.18 — 2026-07-23

### Added
- Rollback now undoes managed-ZTNA staging-dir installs: it removes each staged app directory over the tailnet and re-applies the affected role's bundle (best-effort — a cluster bundle rollback re-pushes the now-app-less bundle). If the target isn't reachable via managed ZTNA, the rollback reports that staging placements need manual cleanup rather than silently skipping them.

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
