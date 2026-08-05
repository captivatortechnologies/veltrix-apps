# Tines (Veltrix app)

Manage **Tines** (security automation / SOAR / workflow orchestration)
configuration as code through the **Tines REST API**, driven through the
Security-as-Code pipeline: validate, deploy (upsert), health check, drift
detection and rollback. See **Coverage** below for the full list of what is
(and, honestly, isn't) managed and why.

- **Category:** SOAR
- **API base (per-tenant):** `https://<tenant-domain>/api/v1`
- **Auth:** API key — `Authorization: Bearer <key>`
- **Database / BYOL:** none (pure REST passthrough)

## Coverage

Seven configuration types are implemented, each reconciled by a stable
identity and driven through the full pipeline (validate / deploy / rollback /
health check / drift detect). Research was done against the official Tines
API reference (`https://www.tines.com/api/...`, fetched 2026-08-05); every
endpoint is cited again in its config type's `_shared.ts`/`deploy.ts`.

| Configuration type | Identity | Endpoint |
| --- | --- | --- |
| Teams | name | `/api/v1/teams` |
| Folders | name (scoped to team + content type + parent) | `/api/v1/folders` |
| Tags | name (scoped to team) | `/api/v1/tags` |
| Global Resources (Shared Values) | name (scoped to team) | `/api/v1/global_resources` |
| Credentials (metadata only) | name (scoped to team) | `/api/v1/user_credentials` |
| Story Settings | story name | `GET /api/v1/stories`, `PUT /api/v1/stories/{id}` |
| Team Members (RBAC) | (team, email) | `/api/v1/teams/{team_id}/invite_member`, `/remove_member` |

### Excluded — the Story graph (agents/links)

**Not implemented, and not planned as a config type.** A Tines Story's actual
automation logic — its agents (nodes: Webhook, HTTP Request, Trigger, Send
Email, ...) and the links between them — is versioned automation code,
authored visually in the Tines Story editor and exported/imported as a JSON
document (`Story.export()`/import in the Tines UI, and the community
`tines-cli` / `tines-tools` ecosystem built around that same export shape).
It has no stable, flat, per-field identity to diff the way a team name or a
tag color does — it's a graph, not a record. This is the same reasoning the
catalog already applies to `apps/splunk-soar`'s Phantom **playbooks**: managed
content, not declarative settings.

This app instead manages **everything ABOUT a Story except the graph
itself** — see **Story Settings** below: whether it's enabled, its priority,
change-control mode, tags, event retention, description and folder. The
config type's `deploy.ts` NEVER creates or deletes a Story — a missing story
name fails the deploy with an actionable message rather than silently
fabricating a graph-less shell.

### Excluded — File-type Global Resources

**Not implemented.** The Global Resources API supports a `file` value type
whose `value.contents` is a base64-encoded binary blob
(`POST /api/v1/global_resources` — file-type Create). A binary blob has no
meaningful text diff and doesn't belong in a canvas built for declarative
config — this app models only the `text`/JSON-string value shape (Tines
auto-detects a JSON-parseable string and stores it typed). Use the Tines UI
or a dedicated artifact pipeline for file-type resources.

### Excluded — HTTP Request Agent and Multi Request Credential modes

**Not implemented as part of Credentials.** Tines Credentials support 7
`mode` values. Five of them — `TEXT`, `AWS`, `JWT`, `OAUTH`, `MTLS` — store
their mode-specific secret material as a **flat set of fields** (a single
value; or `aws_access_key`/`aws_secret_key`/...; or `client_id`/
`client_secret`/...; or a cert + key), which this app models generically as a
`keyvalue` write-only field. `HTTP_REQUEST_AGENT` and `MULTI_REQUEST` do not
fit that shape: their bodies are documented as a request template and an
**ordered array of chained requests**, respectively — nested/array
structures, not flat secret material. Modeling either honestly would mean
either a bespoke per-mode schema (out of scope for a first pass) or an
unstructured JSON escape hatch that blurs the line between "config" and an
opaque blob this app can't validate. `mode` in the canvas is restricted to
the five flat-shaped values; the other two are left to the Tines UI.

### Excluded — Tines "groups" (SSO/SCIM-provisioned)

**Not implemented.** `GET /api/v1/teams/{id}` returns a read-only `groups`
array (`{ id, name }`) on each team, but no `Create`/`Update`/`Delete`
endpoint for a "group" was found anywhere in the Tines API reference —
`groups` here is a group provisioned by an external IdP over SSO/SCIM, not a
resource this app can write. **Team Members** below (invite/remove by email +
role) is the actual writable RBAC primitive Tines exposes.

### Excluded — one-shot actions, read-only surfaces, and secrets

- **Story graph one-shot actions** — running a Story's Test Story Mode,
  exporting/importing the graph, and the Batch Delete Stories endpoint are
  imperative operations, not durable desired state, and stay out of the
  canvas model (same reasoning the rest of this platform's apps use for
  one-shot actions).
- **Resending a member invitation** and **destroying a static external ID**
  (Teams API) are one-shot member-lifecycle actions, not declarative state.
- **Read-only surfaces** — Cases, Records, Audit Logs/Events, AI provider
  usage, and Reporting are Tines-generated operational data this platform's
  Security-as-Code pipeline manages workflow *around*, not configuration to
  author.
- **Secret values are never read back or diffed** — Global Resource values
  ARE modeled (they aren't secret material by design — Shared Values are
  meant to be referenced, not hidden), but a Credential's `value`/mode-specific
  fields are write-only: sent on every deploy when supplied, never captured
  into `rollbackData`, never compared during drift detection. Same trade-off
  as `apps/cribl`'s Secrets type and `apps/splunk-soar`'s Assets
  `configuration`.
- **SSO/SAML tenant configuration** was researched and not found documented
  anywhere in the public Tines API reference as of this research pass — if
  Tines exposes it in a future API version, it should ship with the same
  write-only-secret treatment as Credentials.

## What it manages

### Teams (`teams`)

A Tines team applied over `/api/v1/teams` and reconciled by its **name**.
Tines' top-level scoping unit — every Folder, Tag, Global Resource,
Credential and Story belongs to one Team.

| Field | Notes |
| --- | --- |
| `name` | Required. The reconciliation identity (upsert + drift match). |

### Folders (`folders`)

A Tines folder applied over `/api/v1/folders`. Its true identity is the
tuple **(team, content type, parent folder, name)** — Tines allows the same
name in different scopes.

| Field | Notes |
| --- | --- |
| `name` | Required. |
| `team_id` | Required. Live picker (`optionsSource: teams`). |
| `content_type` | Required: `STORY`, `CREDENTIAL`, or `RESOURCE` — each is its own namespace. |
| `parent_folder_name` | Optional. Resolved by name within the same team + content type. A parent declared earlier in the same deploy resolves in that deploy (two-pass); deeper nesting deploys one level at a time. |

### Tags (`tags`)

A Tines tag applied over `/api/v1/tags` and reconciled by **(team, name)** —
tags created since February 2025 belong to exactly one team.

| Field | Notes |
| --- | --- |
| `name` | Required. |
| `team_id` | Required. Live picker. |
| `color` | Required: one of Tines' named palette (`purple`/`blue`/`gold`/`green`/`magenta`/`red`/`orange`/`mint`) or a custom `#RRGGBB` hex. |

### Global Resources (`global-resources`)

A Tines Global Resource (Shared Value) applied over
`/api/v1/global_resources` and reconciled by **(team, name)**.

| Field | Notes |
| --- | --- |
| `name` | Required. Referenced from a Story as `${{ RESOURCE.<name> }}`. |
| `team_id` | Required. Live picker. |
| `value` | Required. Plain text, or a JSON-parseable string (Tines auto-detects and stores it typed). |
| `folder_name` | Optional. Resolved against the team's `RESOURCE`-type folders. |
| `read_access` / `shared_team_slugs` | `TEAM` (default), `GLOBAL`, or `SPECIFIC_TEAMS` (+ the slugs allowed). |
| `description` | Optional. |

### Credentials (`credentials`) — metadata only

Tines Credential **metadata** applied over `/api/v1/user_credentials` and
reconciled by **(team, name)**. Secret material is WRITE-ONLY (see Coverage).

| Field | Notes |
| --- | --- |
| `name` | Required. Referenced from a Story as `CREDENTIAL.<name>`. |
| `team_id` | Required. Live picker. |
| `mode` | Required: `TEXT`, `AWS`, `JWT`, `OAUTH`, or `MTLS`. |
| `secret_value` (TEXT) / `secret_config` (AWS/JWT/OAUTH/MTLS) | ⚠ Write-only. Required by Tines on create; blank on an existing credential leaves its secret unchanged. |
| `folder_name` | Optional. Resolved against the team's `CREDENTIAL`-type folders. |
| `metadata` | Optional non-secret key/value pairs — round-tripped and diffable. |
| `allowed_hosts` | Optional domain allow-list for HTTP Request actions. |
| `expires_at` / `expiry_notifications_enabled` | Optional expiry tracking. |
| `read_access` / `shared_team_slugs` | Same sharing model as Global Resources. |

### Story Settings (`story-settings`)

Settings of an **EXISTING** Tines Story applied over `GET /api/v1/stories`
(find) + `PUT /api/v1/stories/{id}` (update), reconciled by **story name**.
Never creates, deletes, or edits the graph — see Coverage.

| Field | Notes |
| --- | --- |
| `story_name` | Required. Live picker (`optionsSource: stories`). The story must already exist — deploy fails with a clear message otherwise. |
| `team_id` | Optional. **Search filter only** — disambiguates same-named stories across teams. Never sent in the update body, so this app never moves a story between teams. |
| `disabled` / `priority` / `change_control_enabled` / `monitor_failures` | Lifecycle booleans. |
| `description` / `keep_events_for_days` (1–365, converted to seconds) / `tags` | Retention & classification. `tags` is the full desired list — deploy computes `add_tag_names`/`remove_tag_names` against the story's live tags. |
| `folder_name` | Optional. Resolved against the story's own team's `STORY`-type folders. |

**Excluded from this config type**: `send_to_story_*` / `entry_action_id` /
`exit_action_ids` / `webhook_api_*` / `api_entry_action_id` /
`api_exit_action_ids` — all reference action-node ids inside the Story graph
that only exist once the graph is authored; since this app never manages the
graph, it never resolves or sends those ids.

**A caveat on partial update semantics**: the Tines API reference documents
every field on `PUT /stories/{id}` as optional, which this app reads as "an
omitted field is left unchanged" (a partial update) rather than a full
replace. This was inferred from the documentation, not yet verified against
a live tenant — verify before relying on it in a change-control-sensitive
environment.

### Team Members (`team-members`) — RBAC, additive only

Tines Team membership applied over
`/api/v1/teams/{team_id}/invite_member` (create) and
`/api/v1/teams/{team_id}/remove_member` (delete), reconciled by
**(team, email)**.

| Field | Notes |
| --- | --- |
| `team_id` | Required. Live picker. |
| `email` | Required. |
| `role` | Optional free text — a standard role (`TEAM_ADMIN`, `EDITOR`, `VIEWER`, ...) or a tenant-defined custom role. Tines has **no update-role endpoint**, so a live role that no longer matches is reported as **drift**, never auto-corrected — removing and re-inviting would reset invitation state and re-send an email, a surprising side effect for a routine reconcile. |

Deploy is **additive only**: a member on the canvas but not yet on the team
is invited; a member already on the team is left alone; a member on the
team but absent from the canvas is **never removed** (avoids accidentally
deprovisioning access from a stale canvas). Rollback removes only the
members THIS deploy invited.

## Setup

1. In Tines, create an **API key** (Team Settings, or your personal API key
   page, depending on plan).
2. Store it as a Veltrix credential in the **API token** field.
3. Register a **tines-tenant** component whose hostname is your tenant
   domain (e.g. `acme.tines.com`) and attach the credential.
4. Author any of the configuration types listed in **Coverage** in the
   Configuration Canvas and deploy it through the pipeline. For **Story
   Settings**, author the Story's graph in the Tines Story editor first.

## References

- Tines API overview (base URL, pagination, auth) — https://www.tines.com/api/
- Stories — https://www.tines.com/api/stories, `/list`, `/update`, `/get`, `/delete`
- Teams — https://www.tines.com/api/teams, `/list`, `/update`, `/list-members`, `/invite-member`, `/remove-member`
- Folders — https://www.tines.com/api/folders, `/list`, `/update`
- Global Resources — https://www.tines.com/api/resources, `/list`, `/update`
- Credentials — https://www.tines.com/api/credentials, `/list`, `/update`
- Tags — https://www.tines.com/api/tags, `/list`, `/update`

Every endpoint above is cited again, per config type, in that type's
`_shared.ts`/`deploy.ts` doc comments.

## Development

```
cd apps/tines
node node_modules/typescript/bin/tsc --noEmit         # typecheck
node ../../scripts/test-apps.mjs tines                # run handler tests
node ../../scripts/validate-app.mjs apps/tines         # validate against the app contract
```

## License

Apache-2.0
