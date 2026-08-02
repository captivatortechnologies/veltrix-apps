# Changelog

All notable changes to the pfSense app are documented here.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Firewall Aliases** config type — create / edit / delete pfSense firewall
  aliases (host / network / port groups: `name`, `type`, `descr`, `address[]`,
  `detail[]`) over the third-party **pfSense REST API package**
  (pfSense-pkg-RESTAPI, `/api/v2/firewall/alias(es)`), with validate / deploy
  (upsert by alias name) / rollback (restore prior fields or delete created)
  / health-check / drift-detect / status. Pending changes are applied once
  per deploy (and once per rollback) via `/api/v2/firewall/apply`, not once
  per alias.
- **Connectivity test** against the REST API package (`GET
  /api/v2/system/version`), auto-detecting API-key vs. JWT auth from
  whichever secret the connection's credential carries, self-signed TLS
  tolerated.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (install
  the REST API package → choose an auth method → credential → connection),
  and Connections (wraps the SDK `ConnectionsManager` for a pfSense firewall;
  saving a connection registers `pfsense` as a deploy target).

> **pfSense ships no REST API of its own.** This app depends on the
> third-party pfSense REST API package (pfSense-pkg-RESTAPI, formerly
> jaredhendrickson13/pfsense-api) being installed on the target firewall
> first — a real, separate install step (System > Package Manager >
> Available Packages > "RESTAPI"), not something already running. Chosen
> over pfSense Plus's newer official Netgate API because it works on both CE
> and Plus and is the de-facto community standard. Every API fact (response
> envelope, auth headers/endpoints, alias field set and validation rules,
> the apply/pending-changes model) was verified directly against the
> package's PHP source (`RESTAPI/Models/FirewallAlias.inc`,
> `RESTAPI/Core/Response.inc`, etc.) and pfSense's own
> `is_validaliasname()`/`is_port_or_range()` — see README.md and
> `lib/pfsenseApi.ts` for citations. An alias's `name` is immutable once
> created; pfSense's full reserved-name set is dynamic (depends on the box's
> configured interfaces) and only partially checkable client-side — flagged
> as a warning, not faked as a hard rule. TLS verification is off by default
> (self-signed) and configurable via the `verify_tls` setting.
