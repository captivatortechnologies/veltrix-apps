# Changelog

All notable changes to the GitHub Advanced Security app are documented here.

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
