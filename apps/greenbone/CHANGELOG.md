# Changelog

All notable changes to the Greenbone app are documented here.

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
