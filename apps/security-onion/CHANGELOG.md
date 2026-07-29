# Changelog

All notable changes to the Security Onion app are documented here.

## 0.3.0 — 2026-07-29

Client UI.

- **Overview** — what the app manages in a grid, rendered with the platform
  design system (fed by the app's `/meta` route).
- **Setup Guide** — SOC credential → connection → managed connectivity → author.
- **Connections** — wraps the SDK `ConnectionsManager` for the SOC manager
  (HTTPS 443); saving a connection registers the manager as a deploy target.

> The BYOL infrastructure **management console** (provision/list/deploy UI + its
> server routes) is a tracked follow-on; the declarative provisioning foundation
> (`infra/spec.ts` + Salt bring-up) is already in place and driven by the generic
> provisioning worker.

## 0.2.0 — 2026-07-29

Five more config types — the full six-type set.

- **Firewall Access** — include/exclude hosts in a Security Onion firewall host
  group via `so-firewall` (+ Salt highstate); inverse-undo rollback.
- **SOC Users** — enable/disable existing SOC Console users via `so-user`. (User
  creation + passwords are interactive/stdin and remain a follow-up.)
- **Zeek Configuration** — enable/disable Zeek log types via a declared command
  (representative — verify against a live grid; deep pillar config is a follow-up).
- **Detection Engine Rules** — create/update/delete Elastic/Kibana detection rules
  over the SOC console REST API (443) with drift + rollback.
- **Elasticsearch ILM Policies** — hot-rollover + retention ILM policies over the
  Elasticsearch REST API (9200) with drift + rollback.

Adds `remoteCommands` for `so-firewall`, `so-user`, and `zeek-toggle`, and app
permission resources for each new config type.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **Suricata Rules** config type — enable/disable NIDS rules by SID across the
  grid, applied on the manager via `so-rule` + a Salt highstate over managed ZTNA,
  with validate / deploy / rollback (inverse-undo) / health-check / status.
- **Connectivity test** against the SOC console (HTTPS, self-signed tolerated).
- **BYOL infrastructure** groundwork: declarative `infra/spec.ts` composing the
  generic OpenTofu modules (manager / search / sensor / forward / fleet grid) +
  Salt bring-up entrypoint.
- Uses the platform's new app-declared `remoteCommands` seam so Salt/CLI grid
  operations run over managed ZTNA with per-param validation.

> Grid config is applied via Salt (`so-*`, `salt-call`) and the SOC/Elasticsearch
> REST APIs. Remote command paths follow Security Onion 2.4 conventions and should
> be verified against your grid; the managed-ZTNA remote path ships behind the
> platform's `REMOTE_EXEC_ENABLED` flag.
