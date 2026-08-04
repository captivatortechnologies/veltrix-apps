# Changelog

All notable changes to the Sysdig Secure app are documented here.

## 0.3.0 — 2026-08-04

Full config-as-code exhaustion — nine new config types spanning notifications,
access/scoping, managed-policy tuning, CSPM posture and vulnerability
management, taking this app from 4 to 13 config types. Endpoints were
confirmed against the official `terraform-provider-sysdig` Go client
(`sysdig/internal/client/v2`) — the exact source files and lines are recorded
in each new config type's `_shared.ts`/`deploy.ts` header comment and in the
README's Coverage section.

- **Notification Channels** — Slack, Email, Webhook, PagerDuty, OpsGenie,
  MS Teams, SNS, VictorOps, Team Email and Prometheus Alertmanager channels,
  one polymorphic config type with type-conditional fields, over
  `/api/notificationChannels`.
- **Teams** — scope, capabilities, zone assignment (by name) and members (by
  email, resolved to user ids) over `/api/teams`.
- **Zones** — named, reusable resource scopes (the v1 rules-string API) over
  `/platform/v1/zones`, referenced by name from Teams and the new Posture Zone
  Assignments type.
- **Managed Policies** — tunes (never creates/deletes) Sysdig's own built-in
  runtime policies: enabled state, scope, response actions, disabled rules and
  notification channels, over `/api/v2/policies`. `enabled: false` resets the
  policy to Sysdig defaults, mirroring the Terraform provider's own destroy
  behavior for this resource, since Sysdig-owned content cannot be deleted.
- **Posture Controls** — custom CSPM controls (Rego evaluation rules) over
  `/api/cspm/v1/policy/controls`. This endpoint has no list/search-by-name API
  (confirmed against the Go client), so this type is the first in this app to
  use the SDK's `DeploymentSummary.rollbackData` carry-forward mechanism
  (`{canvas item id -> external id}`) instead of a live by-name lookup.
- **Posture Policies** — CSPM compliance policies built from nested
  requirement groups → requirements → named controls, over
  `/api/cspm/v1/policy` (this API DOES support list-all-with-name, so it
  follows the same by-name upsert pattern as the original four types).
- **Posture Zone Assignments** — assigns an ordered set of Posture Policies
  (by name) to a Zone (by name), a whole-list PUT over
  `/api/cspm/v1/zones/{zoneId}/policies`. Unlike other cross-references in
  this app, an unresolved zone or policy name fails the deploy outright rather
  than being dropped silently — a compliance zone silently missing a policy is
  a security-relevant surprise.
- **Vulnerability Rule Bundles** — reusable pass/fail rules (package/vuln
  denylists, severity thresholds, image-config checks) over
  `/secure/vulnerability/v1/bundles`. No list/search-by-name API — uses the
  same rollbackData carry-forward pattern as Posture Controls.
- **Vulnerability Policies** — bundles plus pipeline/registry/runtime/
  admission-control stage assignment (image-scanning policy assignment) over
  `/secure/vulnerability/v1/policies`. References bundles by numeric id, not
  name, since bundles have no list/search-by-name API either. Same
  rollbackData carry-forward pattern.
- `lib/sysdigApi.ts` gains the client methods and models for all of the above.

> DROPPED (see README Coverage for the full reasoning): Cloud Account /
> Cloud-Auth onboarding (cross-cloud trust-relationship bootstrap, no
> credential-broker seam, provider docs admit instability); the v2
> match-list rule types (`secure_rule_container/filesystem/network/process/
> syscall`) — CONFIRMED DEPRECATED, the Sysdig backend has rejected these
> `ruleType`s since 2026-02-28 per the provider's own docs; Stateful rule
> exceptions (narrow, append-only, single source type); the legacy
> CSPM-specific Posture Zone (`/api/cspm/v1/policy/zones`) — superseded by the
> unified Zones + Zone Posture Policy Assignment modeled here; Managed
> Rulesets (functionally redundant with Managed Policies); posture/
> vulnerability risk-acceptance (a finding-triage action, not desired-state
> config); Cloud Account onboarding, SSO, custom roles, group mappings, IP
> filters and agent access keys (account/platform-wide administration outside
> this app's per-tenant Sysdig-Secure-API-token connection boundary); Monitor-
> side alerts/dashboards/silence rules (a different Sysdig product surface).

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
