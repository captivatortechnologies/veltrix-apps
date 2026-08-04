# Changelog

All notable changes to the GitHub Advanced Security app are documented here.

## 0.3.0 — 2026-08-04

Nine new configuration types, each with the full pipeline (validate / deploy /
rollback / health-check / drift-detect / status) over the GitHub REST API and
tests — exhausting the remaining genuinely-declarative surface of the GitHub
security-config REST API. 13 configuration types total.

- **Code Scanning Default Setup** (`code-scanning-default-setup`) — the FULL
  CodeQL default-setup configuration per repository (state, query suite,
  languages, threat model, runner type/label), complementing the boolean
  toggle already in Repository Security:
  - `GET`/`PATCH /repos/{owner}/{repo}/code-scanning/default-setup`.
  - Rollback re-PATCHes the prior configuration (this endpoint has no
    create/delete concept — only a toggled `state`).
- **Secret Scanning Options** (`secret-scanning-options`) — advanced,
  repository-level secret-scanning sub-settings that complement (patch
  different `security_and_analysis` keys than) Repository Security's base
  toggles: validity checks, non-provider patterns, AI-assisted detection,
  delegated alert dismissal and delegated push-protection bypass (with its
  reviewer list).
  - `PATCH /repos/{owner}/{repo}` (`security_and_analysis`, 5 sub-keys only).
- **Branch Protection (Classic)** (`branch-protection-classic`) — the classic,
  still fully supported (non-ruleset) branch protection API: required status
  checks, pull request reviews, push restrictions, and the other classic
  toggles (`enforce_admins`, `required_linear_history`, `allow_force_pushes`,
  etc.).
  - `GET`/`PUT`/`DELETE /repos/{owner}/{repo}/branches/{branch}/protection`
    (PUT always a full replace).
  - Actor lists (restrictions, dismissal restrictions, bypass allowances) are
    normalized to plain login/slug sets for drift/rollback — GitHub's GET
    echoes full user/team/app objects where the PUT only accepts strings; a
    raw JSON diff would report permanent false drift.
- **Repository Autolinks** (`repo-autolinks`) — key-prefix-to-URL autolink
  references.
  - `GET`/`POST /repos/{owner}/{repo}/autolinks`,
    `DELETE .../autolinks/{id}` — no update endpoint, so a changed value is
    applied as delete + create (documented id churn).
- **Custom Repository Roles** (`custom-repository-roles`) — GitHub Enterprise
  Cloud custom repository roles (name, base role, additional fine-grained
  permissions), upserted by `(org, name)`.
  - `GET`/`POST /orgs/{org}/custom-repository-roles`,
    `PATCH`/`DELETE .../custom-repository-roles/{role_id}`.
  - `permissions` is authored as a free-form list (not a hardcoded enum) since
    GitHub's fine-grained permission catalog evolves independently of this app.
- **Organization Actions Permissions** (`org-actions-permissions`) —
  organization-wide GitHub Actions policy: repository access, allowed
  actions/reusable workflows, default workflow permissions and SHA pinning.
  - `PUT /orgs/{org}/actions/permissions`,
    `PUT .../actions/permissions/repositories` (when scope is Selected),
    `PUT .../actions/permissions/selected-actions` (when allowed actions is
    Selected), `PUT .../actions/permissions/workflow`.
  - Actions **secrets** are explicitly out of scope (secret material, never
    round-trippable) — see README Coverage notes.
- **Organization Member Privileges** (`org-member-privileges`) — default
  repository permission and what members may create, fork, delete or sign off
  on.
  - `GET`/`PATCH /orgs/{org}` (member-privilege fields only).
  - Excludes GitHub's own deprecated `members_allowed_repository_creation_type`
    in favor of the granular `members_can_create_*_repositories` booleans this
    type already exposes.
- **Organization Webhooks** (`org-webhooks`) — payload URL, content type,
  secret, events and active state, upserted by `(org, url)` (GitHub webhooks
  have no user-chosen name).
  - `GET`/`POST /orgs/{org}/hooks`, `PATCH`/`DELETE .../hooks/{hook_id}`.
  - `secret` is write-only (GitHub never echoes it back, same limitation
    already documented for `jfrog-xray`'s Webhooks type) — a blank Secret on
    an existing webhook does not clear it, drift never compares it, and
    rollback cannot restore it.
- **Organization Role Assignments** (`org-role-assignments`) — assign an
  organization role (built-in, e.g. `security_manager`, or custom) to a team.
  This is the GA replacement for the **deprecated** Security Managers API
  (`/orgs/{org}/security-managers/teams/{team_slug}`, which GitHub's own docs
  say is "closing down and will be removed starting January 1, 2026" in favor
  of Organization Roles).
  - `GET /orgs/{org}/organization-roles` (resolve `role_name` → `role_id`),
    `GET .../organization-roles/{role_id}/teams`,
    `PUT`/`DELETE .../organization-roles/teams/{team_slug}/{role_id}`.

**Already covered, not duplicated:** organization-level branch/tag/push
protection rulesets are Repository Rulesets with a blank `repository` field —
no separate "org rulesets" type was added.

**Intentionally dropped** (see README Coverage for the full list and reasons):
secret-scanning custom pattern *authoring* (no public write API — the REST
docs expose alerts/locations/push-protection-bypasses but no
create/update/delete for custom patterns), Actions/Dependabot **secrets**
(secret material), per-alert triage (secret scanning / code scanning / Dependabot
alerts), code-scanning **results**, GitHub Apps / OAuth app management, org
SAML/SSO, deploy keys, and repository transfer/visibility/deletion.

> GitHub REST shapes were verified against docs.github.com/rest
> (code-scanning default-setup PATCH properties incl. `runner_type` /
> `query_suite` / `threat_model`; the full `security_and_analysis` sub-key
> list incl. `secret_scanning_delegated_bypass_options`; Actions permissions'
> four endpoints; `PATCH /orgs/{org}` member-privilege fields;
> classic branch protection's nested shape; autolinks' create/delete-only
> surface; custom repository roles' GA path
> `/orgs/{org}/custom-repository-roles` vs. the deprecated `/custom_roles`;
> organization webhooks; and the Security Managers deprecation notice plus its
> Organization Roles replacement).

## 0.2.0 — 2026-08-01

Three new configuration types, each with the full pipeline (validate / deploy /
rollback / health-check / drift-detect / status) over the GitHub REST API and
tests.

- **Organization Security Configuration** — author org-level GitHub code security
  configurations, identified by `(org, name)`:
  - list / create / update via `GET` / `POST` `/orgs/{org}/code-security/configurations`
    and `PATCH .../configurations/{id}` (upsert by name, PATCH only the changed
    fields; GitHub-provided `target_type: global` configurations are read-only and
    skipped).
  - attach to repositories via `POST .../configurations/{id}/attach`
    (`scope`: all / all_without_configurations / public / private_or_internal /
    selected + `selected_repository_ids`).
  - feature settings exposed as selects (`enabled` / `disabled` / `not_set`) plus a
    free-form additional-settings map for any other GitHub property; `enforcement`
    is `enforced` / `unenforced`. Rollback restores the prior configuration (PATCH)
    or deletes one this app created.
- **Repository Rulesets** — branch / tag / push protection rulesets for a
  repository OR an organization (blank repository → org ruleset), identified by
  `name` within scope:
  - list / create / update / delete via `GET` / `POST` `/repos/{owner}/{repo}/rulesets`
    or `/orgs/{org}/rulesets`, `PUT .../rulesets/{id}` (full replace) and
    `DELETE .../rulesets/{id}`.
  - `rules`, `conditions` and `bypass_actors` are authored as GitHub's own JSON;
    validate parses them statically. Rollback restores the prior ruleset (PUT) or
    deletes one this app created; rulesets this app created but no longer declares
    are reconciled away.
- **Dependabot Configuration** — per-repository Dependabot alerts and security
  updates, identified by `owner/repo`:
  - Dependabot alerts via `PUT` / `DELETE` `/repos/{owner}/{repo}/vulnerability-alerts`
    (GET returns `204` enabled / `404` disabled) — enabling also turns on the
    dependency graph.
  - Dependabot security updates via `PUT` / `DELETE`
    `/repos/{owner}/{repo}/automated-security-fixes` (GET returns `{ enabled, paused }`).
  - alerts are applied before security updates (updates require alerts). Rollback
    restores the prior state of both.

> GitHub REST shapes were verified against docs.github.com/rest (code-security
> configurations, repos/orgs rules, and the vulnerability-alerts /
> automated-security-fixes repo endpoints). Updating a ruleset is `PUT` (a full
> replace), not `PATCH`; a code security configuration update is `PATCH`.
> Applying Advanced Security features to PRIVATE repositories requires a GitHub
> Advanced Security licence.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Repository Security** config type — enable / disable GitHub Advanced Security
  features per repository (`owner/repo`) over the GitHub REST API:
  - GitHub Advanced Security, secret scanning and secret scanning push protection
    via `PATCH /repos/{owner}/{repo}` (`security_and_analysis`).
  - Dependabot security updates via `PUT` / `DELETE`
    `/repos/{owner}/{repo}/automated-security-fixes`.
  - CodeQL code-scanning default setup via
    `PATCH /repos/{owner}/{repo}/code-scanning/default-setup`.
  - Full pipeline: validate (static, with feature-dependency warnings) / deploy
    (records prior state per repo) / rollback (restore prior state) / health-check
    / drift-detect (`GET` the three read endpoints) / status.
- **Connectivity test** against the GitHub REST API (`GET /user`) using a token
  sent as `Authorization: Bearer <token>` with `X-GitHub-Api-Version: 2022-11-28`.
- **GitHub Enterprise Server** support — the REST base is derived from the
  connection endpoint (`https://<host>/api/v3`) and overridable via the
  `api_base_url` app setting; GitHub.com (`https://api.github.com`) is the default.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (token →
  connection → author) and Connections (wraps the SDK `ConnectionsManager`; saving
  a connection registers `github-org` as a deploy target).

> GitHub REST shapes were verified against docs.github.com/rest. Note that
> `dependabot_security_updates` is NOT part of the `security_and_analysis` object —
> it is the dedicated automated-security-fixes endpoint. Applying Advanced Security
> features to PRIVATE repositories requires a GitHub Advanced Security licence.
