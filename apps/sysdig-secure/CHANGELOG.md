# Changelog

All notable changes to the Sysdig Secure app are documented here.

## 0.2.0 — 2026-08-01

Threat-detection breadth — three new config types alongside Falco Rules, each
with validate / deploy (upsert by name) / rollback / health-check / drift-detect
/ status, and each modeling `enabled: false` as "absent" (removed on deploy).

- **Runtime Policies** config type — manage Sysdig Secure runtime policies (name,
  description, severity 0–7, referenced rule names, response actions
  [stop / pause / kill] and scope) over the REST API (`/api/v2/policies`). Policy
  `type` is `falco` (rule-referencing). Upsert matches by name across the full
  policy list (Sysdig has no by-name policy lookup).
- **Falco Lists** config type — manage custom Falco lists (name + items), a named
  set of literals reusable across rules and macros, over
  `/api/secure/falco/lists` (with `/groups?name=` for the by-name lookup).
- **Falco Macros** config type — manage custom Falco macros (name + condition),
  reusable condition fragments, over `/api/secure/falco/macros` (with
  `/groups?name=` for the by-name lookup).
- Shared `lib/sysdigApi.ts` gains policy / list / macro client methods and models.

> Endpoints were confirmed against the official `terraform-provider-sysdig`
> client (CRUD by id) and the official `python-sdc-client` (the `/groups?name=`
> by-name lookups), and should be verified against a live Sysdig Secure. NOTE
> these paths differ from the informal ones in the original brief: policies live
> at `/api/v2/policies` (not `/api/policies/v2`), and lists/macros have their own
> endpoints (not `/api/secure/rules?type=FALCO_LIST|FALCO_MACRO`). Response
> action type strings (`POLICY_ACTION_STOP|PAUSE|KILL`) and the severity 0–7
> scale are from the Sysdig client sources; the exact live acceptance of a
> notify-only (empty-actions) policy should be confirmed against a tenant.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Falco Rules** config type — create / edit / remove Sysdig Secure custom Falco
  (threat-detection) rules (name, description, condition, output, priority,
  source, tags, enabled) over the Sysdig Secure REST API (`/api/secure/rules`),
  with validate / deploy (upsert by rule name) / rollback (restore prior,
  re-create, or remove) / health-check / drift-detect / status.
- **Connectivity test** against the Sysdig Secure REST API
  (`GET /api/secure/rules/groups`, Bearer API token over HTTPS).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API token
  → connection → author), and Connections (wraps the SDK `ConnectionsManager`
  for a Sysdig tenant addressed by its region base URL; saving a connection
  registers `sysdig-secure` as a deploy target).
- Sysdig SaaS — no BYOL infrastructure or app database.

> Sysdig Secure API paths and the Falco-rule JSON shape were confirmed against
> the official `terraform-provider-sysdig` client and Sysdig docs, and should be
> verified against a live Sysdig Secure. Sysdig has no per-rule enabled toggle
> (rules are enabled via policies), so `enabled: false` is modeled as "absent
> from the custom rule library" (the rule is deleted).
