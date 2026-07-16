# Snyk

Manage **Snyk** organization configuration as code on the Veltrix Security-as-Code
platform. Author configurations in the Configuration Canvas and deploy them
through the pipeline — validation, drift detection, health checks and rollback
are handled per configuration type.

Snyk is primarily a scanner rather than a configuration platform, so its
config-as-code surface is intentionally focused. This app covers the parts of a
Snyk organization that are genuinely API-manageable and stable.

## What it manages

| Configuration type | Snyk API | Scope | Notes |
| --- | --- | --- | --- |
| **Snyk Code (SAST) Settings** | REST `PATCH /orgs/{org}/settings/sast` | Org | Singleton toggle for Snyk Code |
| **Notification Settings** | v1 `PUT /org/{org}/notification-settings` | Org | Singleton notification preferences |
| **Integration Settings** | v1 `PUT /org/{org}/integrations/{id}/settings` | Org | PR-test and auto-upgrade settings, matched by integration **type** |
| **Service Accounts** | REST `/orgs/{org}/service_accounts` | Org | The generated API token is shown **once** by Snyk and is never stored here |
| **Webhooks** | v1 `/org/{org}/webhooks` | Org | Reconciled by **URL**; the signing secret is **write-only** |

## Connecting

1. **Service-account token** — in Snyk, create a service account (Settings >
   Service accounts) with a role scoped to what this app manages and copy its API
   token.
2. **Credential** — store the token in the Veltrix credential **API token**
   field. The app sends it as `Authorization: token <token>`.
3. **Component** — register a `snyk-org` component whose hostname is your Snyk
   **region API host**:
   - `api.snyk.io` — US (default)
   - `api.eu.snyk.io` — EU
   - `api.au.snyk.io` — AU

   Snyk tokens are region-scoped, so the host must match the account's region.
4. **Organization ID** — set the `Organization ID` app setting (Snyk: Settings >
   General > Organization ID). Most Snyk configuration is org-scoped, so it is
   required for deployments.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `org_id` | — (required) | The Snyk organization ID all config types target |
| `api_version` | `2024-10-15` | Dated version for the Snyk REST API (`?version=`) |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Notes & limitations

- **Two APIs.** Snyk runs a modern REST API (JSON:API, `?version=` required) and
  a legacy v1 API in parallel; config is split across both. This app talks to
  whichever one owns each object.
- **Write-only secrets.** Webhook signing secrets are sent only on create, never
  read back, never diffed in drift detection, and never stored in rollback data
  or artifacts. Because Snyk cannot update a webhook in place, an existing URL is
  left unchanged (its secret cannot be rotated through this config type).
- **Service-account tokens.** Snyk returns a service account's API token exactly
  once, at creation. This app does not capture or store that token — retrieve it
  from the deployment operator's context at create time.
- **Integration settings** apply to an integration that already exists in the
  org (identified by type, e.g. `github`, `gitlab`). Connecting an SCM to Snyk is
  done in Snyk itself; this app manages the integration's PR-test and
  dependency-upgrade behaviour.
- **Out of scope (by design):** IaC has no equivalent org-level settings
  endpoint to SAST; project-scoped ignores require pre-imported projects; and
  Security Policies are feature-flag-gated (Snyk Code Consistent Ignores) with no
  general policy API. These are omitted rather than shipped half-working.

## License

Apache-2.0
