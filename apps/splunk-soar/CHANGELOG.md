# Changelog

All notable changes to the Splunk SOAR app are documented here. This file
starts at v1.2.0 — prior releases (v1.0.0–v1.1.2) predate this changelog.

## 1.2.0 — 2026-08-05

Config-as-code surface exhaustion — researched the full Splunk SOAR REST API
and added eight configuration types, taking coverage from 1 (`connection`) to 9:

- **Severities** (`severities`) — name, color, default flag, full add/edit/delete.
- **Container Statuses** (`container-statuses`) — custom status labels (name,
  category, default flag), full add/edit/delete.
- **Container Labels** (`container-labels`) — ensures declared labels exist
  (add-only — SOAR's API has no rename).
- **Custom Fields** (`custom-fields`) — CEF field definitions (name + data
  types), full add/edit/delete.
- **Custom Lists** (`custom-lists`) — named lookup/allow/block lists, full
  content replace.
- **Roles** (`roles`) — roles and their permission flags across all 9
  documented SOAR permission categories, full add/edit/delete.
- **Automation Accounts** (`automation-accounts`) — service accounts
  (`type: automation` only), full add/edit/delete; never manages a password.
- **Assets** (`assets`) — asset instances of installed SOAR apps; non-secret
  fields (identity, ownership, tags, tenants, polling) are fully managed,
  free-form per-app `configuration` is write-only (sent, never read back or
  diffed — mirrors `apps/cribl`'s Secrets type).

Cross-cutting finding: Splunk SOAR restricts `DELETE` to a user-authenticated
credential — an automation API token cannot delete records (Custom Lists is
the one documented exception). Every new type's rollback documents this and
surfaces a clear failure rather than silently no-op'ing when it applies.

Dropped after research (see README Coverage): Playbooks/Custom Functions/
Automation Broker scripts (versioned code in SOAR's own Source Control, not
canvas configuration), Workbook Templates (create-only REST surface — no
list-by-name, update, or delete, so not idempotently round-trippable),
Tenants/Multi-tenancy (`GET`-only, no write path found), System Settings
(whole-section replace mixing unrelated feature flags with IdP secrets), and
one-shot actions / read-only case data (unchanged reasoning from prior
releases).

## Earlier versions (undocumented)

Releases through v1.1.2 predate this changelog. This app's `connection`
configuration type (SOAR instance connection profile: endpoint reachability,
TLS, timeout, retries) shipped in that range.
