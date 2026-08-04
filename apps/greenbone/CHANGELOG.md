# Changelog

All notable changes to the Greenbone app are documented here.

## 0.4.0 — 2026-08-04

Exhausted the remaining genuinely-declarative GMP config-as-code surface —
**11 new configuration types**, all built research-first against the GMP 22.5
command reference and python-gvm, reusing the existing hand-rolled GMP
XML-over-TLS seam (`lib/greenboneApi.ts`). The BYOL infrastructure hosting
foundation is untouched.

- **Scan Configs** (`scan-configs`, group *Scan Configuration*) — `create_config`
  is clone-only (there is no from-scratch authoring in GMP); this type clones a
  base config (default: the feed's "Full and fast") then tunes it via one
  `modify_config` call carrying name/comment/family selection/NVT
  selection/scanner preferences (declared as JSON, following Cisco Meraki's
  typed-fields-plus-JSON-blob precedent). Drift compares name/comment only —
  the family/NVT/preference selection is always re-applied on deploy rather
  than diffed (the live shape is far richer than the declared JSON — see the
  module's FLAGS).
- **Scanners** (`scanners`, group *Scan Configuration*) — additional scanner
  endpoints (host/port/type/CA cert). `create_scanner` hard-requires an
  **existing** GMP credential id — this app does not create or store GMP
  credentials (see Credentials below), so a scanner references one the
  operator already created in the Greenbone UI. `modify_scanner` always
  resends every field (its RNC declares host/port/type non-optional even on
  modify).
- **Alerts** (`alerts`, group *Alerts*) — event/condition/method, scoped to
  **secret-free methods only**: Email (plain), HTTP Get, Syslog, Start Task,
  SNMP (inline community). SCP, SMB, TippingPoint SMS and verinice Connector
  are deliberately excluded — they store a Credential UUID reference this app
  does not manage. `test_alert` (a live test-fire) is a runtime action and is
  not exposed.
- **Filters** (`filters`, group *Filters & Tags*) and **Tags** (`tags`, group
  *Filters & Tags*) — named search terms and name/value resource labels.
  Tags' resource-attachment list uses the `<resources><type/><resource
  id/>…</resources>` wrapper (python-gvm's tested shape) with `action="set"`
  on modify (full replace, idempotent).
- **Groups** and **Roles** (group *Access Control*) — named user sets and
  custom roles. A group's "full access to each other" flag is create-only
  (`modify_group` cannot change it — surfaced as a deploy note, mirroring
  port-lists' immutable-range pattern). The **7 predefined/protected roles**
  (Admin, User, Observer, Guest, Info, Monitor, Super Admin — their UUIDs read
  directly from gvmd server source) are never targeted for create/modify/delete.
- **Permissions** (`permissions`, group *Access Control*) — grants a GMP
  command (or the special "Super") to a user/group/role, optionally
  resource-scoped. A permission has **no name field** — this type tracks
  identity by the canvas item's own stable id across deploys (the same
  pattern `apps/pfsense/config-types/static-routes` uses for a nameless
  resource), including deleting a permission whose canvas item was removed.
- **Report Formats** (`report-formats`, group *Reporting*) — **scoped strictly
  to cloning + activate/rename/tune-params** of an existing (usually
  predefined) format. The raw `get_report_formats_response`/file-import path
  — which installs an executable report-generation script server-side — is
  never used. `verify_report_format` (a feed-signature check) is a runtime
  action and is not exposed.
- **Overrides** and **Notes** (group *Findings*) — persistent, re-appliable
  severity-override / comment annotations on a specific NVT's results. Neither
  has a name field; both use the same canvas-item-id identity tracking as
  Permissions, including reconciling deletes for removed canvas items.
- **Intentionally dropped** (see the README's new **Coverage** section for the
  full accounting): **Credentials** (all 7 GMP credential types carry secret
  material — password, private key, or community string — with no exception);
  **Tickets** (permanently bound to one point-in-time scan result, with no
  name field — a workflow record, not reusable declarative config); every GMP
  **runtime action** (`test_alert`, `verify_scanner`, `verify_report_format`,
  `sync_config`, task start/stop, etc.).

Every new type ships the same `validate`/`deploy`/`rollback`/`healthCheck`/
`driftDetect`/`getStatus` handler set as the existing four, plus unit tests for
its GMP XML command assembly and response parsing (the live socket path
remains unmockable — house convention). The GMP wire-format builders/parsers
for these 11 entities live one-file-per-entity under the new `lib/gmp/`
directory (built on the transport + escaping/parsing primitives already in
`lib/greenboneApi.ts`, which now also exports those primitives) to keep any
one file from growing unmanageably large.

> GMP is version-specific; several shapes here carry an explicit UNVERIFIED
> flag pending confirmation against a live gvmd — see each `lib/gmp/*.ts`
> module doc and the README's Coverage section (scanner types 3/5 beyond the
> doc-confirmed 2, the exact GMP version `usage_type` was introduced, whether
> `modify_ticket` would accept "Fix Verified", the literal wire acceptance of
> the "Super" permission name).

## 0.3.0 — 2026-08-01

BYOL infrastructure hosting for the Greenbone / OpenVAS stack — the app now owns
end-to-end stack provisioning alongside GMP configuration authoring, mirroring
the node_tiers-native BYOL model.

- **Infrastructure console** — a new "Infrastructure" page (SDK
  `<ByolInfrastructureManager>` over the app-owned `/byol` routes) to define a
  stack's topology, deploy it to a Veltrix-hosted or your own cloud account
  (BYOC), preview a Terraform-style plan, and manage its lifecycle
  (start / stop / restart / destroy).
- **node_tiers-native topology** — two user-scalable node tiers, **Manager
  nodes** (gvmd + GSA web, the ALB target, min 1) and **Scanner nodes**
  (openvas-scanner, min 1), persisted ONLY in a `node_tiers` JSONB column (no
  legacy count columns). The server adds the fixed supporting services —
  **PostgreSQL** (gvmd database) and **Redis** (scanner key-value store) — plus
  the foundation (network, load balancer, DNS, TLS, secrets) automatically. A
  single-node deployment collapses to one all-in-one box.
- **Declarative InfraSpec** (`infra/spec.ts`) — GSA web on HTTPS 443 behind the
  ALB, GMP 9390 + PostgreSQL 5432 + Redis 6379 as peer/self rules, WAF on, no
  object storage. Composes the SAME generic OpenTofu modules as every other BYOL
  app purely by declaring data.
- **Provisioning + usage foundation** — resource plan, deployment runs + ordered
  steps, a lifecycle state-event log and a daily node-hours usage ledger, in two
  `greenbone_`-prefixed migrations (`002_greenbone_byol.sql`,
  `003_greenbone_byol_usage.sql`). The existing GMP configuration seam
  (`lib/greenboneApi.ts`) is untouched.

## 0.2.0 — 2026-08-01

Three more config types, all driven through the same GMP-over-TLS seam
(`lib/greenboneApi.ts`) with validate / deploy (upsert by name) / rollback /
health-check / drift-detect / status. XML command assembly + response parsing are
unit tested; the live socket path is unmockable (house convention).

- **Port Lists** config type — named TCP/UDP port ranges over `create_port_list` /
  `get_port_lists` / `modify_port_list` / `delete_port_list`. The canvas
  `T:1-1024,U:53` string is canonicalised to the same form gvmd's structured
  `<port_range>` triples reconstruct to, so drift compares cleanly.
- **Schedules** config type — iCalendar (RFC 5545) recurrence + timezone over
  `create_schedule` / `get_schedules` / `modify_schedule` / `delete_schedule`.
- **Scan Tasks** config type — target + scan config + scanner (and an optional
  schedule) over `create_task` / `get_tasks` / `modify_task` / `delete_task`.
  **Foreign keys are resolved BY NAME** (or a pasted UUID) against the live gvmd:
  deploy reads `get_targets` / `get_configs` / `get_scanners` / `get_schedules`,
  maps each name to its id, then upserts. Config/scanner default to the common feed
  names *Full and fast* / *OpenVAS Default*.
- **Shared handlers** — `lib/health.ts` (gvmd-reachable check) and `lib/status.ts`
  (deployment status) are reused by all three new config types (DRY).

> GMP-version-specific behaviour (verified against the GMP 22.5 reference +
> python-gvm v224 request builders; confirm on your appliance):
>
> - **Schedules** use a single `<icalendar>` element (**GMP 20.08+**) — the old
>   `<first_time>` / `<period>` / `<duration>` model is gone. gvmd keeps only
>   **DTSTART / DTEND / DURATION / RRULE** from the VEVENT and reformats the rest,
>   so drift compares those extracted keys, not the raw text.
> - **Scan tasks** require `<usage_type>scan</usage_type>` (**GMP 9.0+**) and
>   reference config/target/scanner as **empty id-bearing elements**
>   (`<config id="…"/>`). `modify_task` **cannot re-point** config/target/scanner on
>   a task that has already run unless it is *alterable* (gvmd #1305) — deploy only
>   re-sends a foreign key that actually changed, so an unchanged re-deploy never
>   trips this.
> - **Port lists** — `modify_port_list` only changes name/comment; the port
>   **ranges are immutable via modify** (a range edit needs a recreate). Deploy
>   surfaces a changed range rather than silently dropping it; drift flags it.
>
> BYOL infrastructure hosting for the Greenbone stack is still deferred to a later
> wave.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Scan Targets** config type — create / edit / delete Greenbone scan targets
  (name, hosts, exclude hosts, port list) over the Greenbone Management Protocol
  (GMP), with validate / deploy (upsert by target name) / rollback (delete created
  or restore modified) / health-check / drift-detect / status.
- **GMP transport seam** (`lib/greenboneApi.ts`) — a `node:tls` socket client that
  opens the connection, authenticates (`<authenticate>`), sends one GMP XML command
  and reads one XML response, plus a minimal hand-rolled XML builder/parser
  (`create_target` / `get_targets` / `modify_target` / `delete_target`,
  status/`status_text`/`id` parsing). No external XML dependency. The transport is a
  clear, swappable seam.
- **Connectivity test** — opens a GMP-over-TLS socket to gvmd (default 9390),
  authenticates the stored username/password, and reads `<get_version/>`.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (GMP account
  → connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  gvmd manager; saving a connection registers `greenbone` as a deploy target).

> GMP is XML over a TLS socket (default port 9390), NOT REST. Protocol shapes here
> follow the GMP 22.5 reference + python-gvm and should be verified against a live
> gvmd (GMP is version-specific). Plain TLS on 9390 is the classic transport and is
> deprecated in newer Greenbone OS in favour of an SSH-tunnelled unix socket.
>
> BYOL infrastructure hosting for the Greenbone stack (gvmd + scanner + feed +
> database) is planned for a later release — no database is bundled yet.
