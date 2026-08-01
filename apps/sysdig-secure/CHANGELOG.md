# Changelog

All notable changes to the Sysdig Secure app are documented here.

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
