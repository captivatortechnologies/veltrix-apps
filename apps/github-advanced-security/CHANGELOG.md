# Changelog

All notable changes to the GitHub Advanced Security app are documented here.

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
