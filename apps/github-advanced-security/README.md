# GitHub Advanced Security

Manage **GitHub Advanced Security** posture as code. Author per-repository security
configurations in the Veltrix Configuration Canvas and drive them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback — over the GitHub REST API.

- **Category:** COMPLIANCE
- **Vendor:** Veltrix
- **API:** GitHub REST API (`https://api.github.com`, or GitHub Enterprise Server
  at `https://<host>/api/v3`)

## What it manages

Four configuration types, each with the full Security-as-Code pipeline.

### Repository Security (`repo-security-config`)

Each item is a repository (`owner/repo`) with the desired on/off state of five
features:

| Field | GitHub endpoint |
| --- | --- |
| `advanced_security` | `PATCH /repos/{owner}/{repo}` → `security_and_analysis.advanced_security` |
| `secret_scanning` | `PATCH /repos/{owner}/{repo}` → `security_and_analysis.secret_scanning` |
| `secret_scanning_push_protection` | `PATCH /repos/{owner}/{repo}` → `security_and_analysis.secret_scanning_push_protection` |
| `dependabot_security_updates` | `PUT` / `DELETE /repos/{owner}/{repo}/automated-security-fixes` |
| `code_scanning_default_setup` | `PATCH /repos/{owner}/{repo}/code-scanning/default-setup` (`state: configured \| not-configured`) |

Drift and rollback read the current state from `GET /repos/{owner}/{repo}`,
`GET /repos/{owner}/{repo}/automated-security-fixes` and
`GET /repos/{owner}/{repo}/code-scanning/default-setup`.

### Organization Security Configuration (`org-security-configuration`)

Each item is an org-level code security configuration, identified by `(org, name)`.
Feature settings (`advanced_security`, `secret_scanning`, `code_scanning_default_setup`,
`dependency_graph`, `dependabot_alerts`, `dependabot_security_updates`,
`private_vulnerability_reporting`, …) are `enabled` / `disabled` / `not_set`, plus
`enforcement` (`enforced` / `unenforced`).

| Operation | GitHub endpoint |
| --- | --- |
| List / match by name | `GET /orgs/{org}/code-security/configurations` |
| Create | `POST /orgs/{org}/code-security/configurations` |
| Update (changed fields only) | `PATCH /orgs/{org}/code-security/configurations/{id}` |
| Delete (rollback of a create) | `DELETE /orgs/{org}/code-security/configurations/{id}` |
| Attach to repositories | `POST /orgs/{org}/code-security/configurations/{id}/attach` |

### Repository Rulesets (`repository-rulesets`)

Each item is a branch / tag / push protection ruleset for a repository (`owner` +
`repository`) or an organization (`owner` only, `repository` blank), identified by
`name` within scope. `rules`, `conditions` and `bypass_actors` are authored as
GitHub's own JSON.

| Operation | GitHub endpoint |
| --- | --- |
| List / match by name | `GET /repos/{owner}/{repo}/rulesets` or `/orgs/{org}/rulesets` |
| Read full (rollback capture) | `GET .../rulesets/{id}` |
| Create | `POST .../rulesets` |
| Update (full replace) | `PUT .../rulesets/{id}` |
| Delete (reconcile / rollback of a create) | `DELETE .../rulesets/{id}` |

### Dependabot Configuration (`dependabot-config`)

Each item is a repository (`owner/repo`) with the desired state of Dependabot
alerts and security updates.

| Field | GitHub endpoint |
| --- | --- |
| `vulnerability_alerts` | `PUT` / `DELETE /repos/{owner}/{repo}/vulnerability-alerts` (GET → `204` enabled / `404` disabled) |
| `security_updates` | `PUT` / `DELETE /repos/{owner}/{repo}/automated-security-fixes` (GET → `{ enabled, paused }`) |

## Authentication

The app authenticates to GitHub with a **token** — a fine-grained personal access
token, a classic PAT, or a GitHub App installation token. It is sent as:

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: veltrix-github-advanced-security
```

Required permissions to change security settings:

- **Fine-grained PAT:** repository **Administration** and **Code security**
  (read & write).
- **Classic PAT:** the `repo` and `security_events` scopes.

Store the token as a Veltrix credential (token / "API token" field) on the
**Connections** page. No username is required.

## Setup

1. **Token** — create a token with the permissions above.
2. **Connection** — on **Connections**, add a connection whose endpoint is
   `api.github.com` (GitHub.com) or your GHES host, attach the token, and press
   **Test** (verifies `GET /user`). Saving registers a `github-org` deploy target.
3. **Author & deploy** — in the **Configuration Canvas**, pick **Repository
   Security**, add repositories by `owner/repo`, toggle the features, and deploy.

## GitHub Enterprise Server

Set the connection endpoint to your GHES host and the app will reach it at
`https://<host>/api/v3`. To point at a non-standard base, set the `api_base_url`
app setting explicitly.

## Notes & caveats

- `dependabot_security_updates` is **not** part of the `security_and_analysis`
  object — it is the dedicated `automated-security-fixes` endpoint. This app maps
  the canvas toggle to `PUT` (enable) / `DELETE` (disable).
- On **private** repositories, secret scanning and code scanning require a **GitHub
  Advanced Security** licence; `advanced_security` must be enabled first (the
  deploy sends it in the same `security_and_analysis` PATCH, ahead of code
  scanning). Public repositories get these features without a licence.
- Code-scanning default setup auto-detects languages; enabling it issues
  `{ state: "configured" }`, which GitHub may process asynchronously (HTTP 202).
- `advanced_security` is GitHub's current key for GHAS; newer API schemas also
  expose an equivalent `code_security` slot — **verify against your live GitHub /
  GHES version** if a future schema deprecates `advanced_security`.

## Development

```bash
npm run typecheck        # from apps/github-advanced-security
node ../../scripts/validate-app.mjs apps/github-advanced-security   # from repo root
node ../../scripts/test-apps.mjs github-advanced-security
```
