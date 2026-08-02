# Changelog

All notable changes to the Greenbone app are documented here.

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
