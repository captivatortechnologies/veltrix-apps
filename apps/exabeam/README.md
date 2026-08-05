# Exabeam

Manage [Exabeam](https://www.exabeam.com/) New-Scale Security Operations Platform **correlation
rules** (real-time detection content) as code through the **Exabeam Correlation Rules API**. Author
configurations in the platform's Configuration Canvas and deploy them through the Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback are handled per configuration
type.

This is a **research-first, intentionally narrow** first release. See **Coverage** below for the full,
sourced breakdown of what was investigated and why everything except Correlation Rules is out of scope
today.

## Credentials

The app authenticates with an **Exabeam API Key** using the OAuth2 `client_credentials` grant:

1. In the Exabeam console, go to **Settings → API Keys** and create a new key.
2. Assign it a permission set that covers **Correlation Rules** (read/write).
3. Copy its **Key** and **Secret** — the secret is shown once.

Store them as a Veltrix credential:

| Veltrix credential field | Exabeam value |
| --- | --- |
| Username | API **Key** |
| API token | API Key **Secret** |

Register an **`exabeam-tenant`** component and attach the credential. Exabeam's API has **no
per-tenant id in the URL** — a tenant is fully identified by the API Key itself — so the component's
hostname/endpoint is never read by this app; the platform still needs a non-blank value to create the
deploy target, so any short label works. Set the app's **Region** setting to match where the tenant is
actually provisioned (US West / US East / Singapore / Japan / EU / Australia / Canada / Switzerland /
South America / UK) — it does not auto-detect.

On every request the app exchanges the API Key for a short-lived access token via
`POST https://api.<region>.exabeam.cloud/auth/v1/token` (JSON body:
`{ client_id, client_secret, grant_type: "client_credentials" }`), then calls
`https://api.<region>.exabeam.cloud/correlation-rules/v2/...` with `Authorization: Bearer <token>`.

**Token hygiene** — Exabeam's own [Authentication guide](https://developers.exabeam.com/exabeam/docs/api-keys)
states tokens are valid for ~4 hours and explicitly warns *"Do NOT request a token every time an API
call is made"*, capping a key at roughly 6 token requests per 24 hours (i.e. one per token lifetime).
This client caches the token for its full reported `expires_in` and only re-authenticates within 5
minutes of expiry or on a 401 — never per request. The guide also documents per-source-IP rate limits
(50 req/5 min for the auth endpoint, 100 req/min for the public APIs), reinforced by every handler
making the minimum number of calls needed (see **Health check** below).

## What it manages

| Configuration type | Exabeam object(s) | API |
| --- | --- | --- |
| Correlation Rules | Real-time correlation (detection) rules — sequence(s), EQL query/condition, severity, enablement, test mode, suppression/delay/schedule | `/correlation-rules/v2/rules` |

A rule's identity is its **name** (this app's own reconciliation key — the API itself enforces no
uniqueness constraint on `name`). `sequencesConfig` and the optional `suppressConfig` / `delayConfig` /
`scheduleConfig` are authored as raw JSON text rather than fully decomposed canvas controls — their
shape (nested sequence/condition trees, EQL search strings) varies enormously per rule and mirrors
exactly what the API's create/update body expects, the same convention `ping-identity` uses for its
sign-on-policy condition trees. Every JSON field's wire shape is documented in its help text in
`canvas.yaml` with a worked example.

## Coverage

**This release ships exactly one configuration type: Correlation Rules.** That is not a starting
slice of a larger roadmap — it is the full extent of what research against Exabeam's public API
reference (`developers.exabeam.com`) found to be a genuinely complete, safely-reconcilable
create/read/update/delete surface, as of 2026-08. Every other surface the task brief asked to verify
was investigated and found to be either read-only, a one-way create-only door with no delete/rollback
path, or to have no public REST surface at all. That finding is itself notable: per Exabeam's own
changelog, the Correlation Rules endpoints, the Threat Detection Management (analytics rules)
endpoints, and the manual-case-creation endpoint were **all added within the eight months before this
release** (Dec 2025–May 2026) — the New-Scale platform's public write API is genuinely young, and this
app reflects exactly how much of it currently exists, not a self-imposed limit.

### Correlation Rules — why it's viable

Verified directly against the Exabeam API reference:

- List: [`GET /correlation-rules/v2/rules`](https://developers.exabeam.com/exabeam/reference/correlation-get-all-rules) (optional `nameContains` filter)
- Read: [`GET /correlation-rules/v2/rules/{ruleId}`](https://developers.exabeam.com/exabeam/reference/correlation-get-rule-by-id)
- Create: [`POST /correlation-rules/v2/rules`](https://developers.exabeam.com/exabeam/reference/correlation-create-rule)
- Update: [`PUT /correlation-rules/v2/rules/{ruleId}`](https://developers.exabeam.com/exabeam/reference/correlation-update-rule)
- Delete: [`DELETE /correlation-rules/v2/rules/{ruleId}`](https://developers.exabeam.com/exabeam/reference/correlation-delete-rule-by-id)
- Bulk alternatives also exist — [import (file, ≤50 rules/4MB)](https://developers.exabeam.com/exabeam/reference/correlation-import-rules)
  and [export (by ruleIds, ≤50)](https://developers.exabeam.com/exabeam/reference/correlation-export-rules) —
  but this app uses the single-item endpoints above so every canvas item reconciles independently
  (create, update-in-place, or delete) rather than an all-or-nothing bulk file.

This is a complete lifecycle: every field this app writes can also be read back and deleted, which is
what makes drift detection and rollback honest rather than best-effort.

### Investigated and excluded (with reasons)

| Surface | What was found | Why excluded |
| --- | --- | --- |
| Analytics (UEBA) Rules — Threat Detection Management | [`GET /detection-management/v1/analytics-rules`](https://developers.exabeam.com/exabeam/reference/detection-management-get-all-analytics-rules) (list), [`POST .../import`](https://developers.exabeam.com/exabeam/reference/detection-management-import-rules) (bulk create, ≤50/4MB), [`POST .../export`](https://developers.exabeam.com/exabeam/reference/detection-management-export-rules) (bulk read by ids) | **Create-only, no way back.** Repeated, convention-matched probes for a per-rule `GET`, `PUT`/update, `DELETE`, or even an enable/disable toggle all 404 — none exist. A type that can create but never cleanly update, delete, or roll back what it created would make this app's own rollback dishonest (it could only report "cannot remove"). Deferred until Exabeam exposes a real per-rule lifecycle here, matching the same standard Correlation Rules already meets. |
| Case / incident management (Threat Center) | [`POST /threat-center/v1/manual-cases`](https://developers.exabeam.com/exabeam/reference/threat-center-create-manual-case-v1) (create), [`GET .../v1/cases/{id}`](https://developers.exabeam.com/exabeam/reference/threat-center-get-case-by-id), [`POST .../v2/cases/{id}`](https://developers.exabeam.com/exabeam/reference/threat-center-update-case-by-id-v2) (update) | Write-capable, but a case is a live incident record, not declarative infrastructure — there is no stable "desired state" to declare ahead of time and reconcile against (an analyst reassigning/closing a case *is* the intended workflow, not drift). The same reasoning this task's brief applies to read-only events/alerts/timelines. |
| Case queues / case stages | [Configure Threat Center guide](https://docs.exabeam.com/en/threat-center/all/threat-center-guide/configure-threat-center.html) confirms these are admin-configurable | **UI only** — the guide documents create/edit/delete for both entirely through the console; no REST endpoint was found (nor referenced by the guide) for either. |
| Detection Grouping Rules | Guide documents a full CRUD-shaped UI (create/enable/disable/reorder/clone/edit/delete/history) at `configure-threat-center/detection-grouping.html` | No API reference page found under any convention-matched slug (`*detection-grouping*`) despite the guide's "API Docs" cross-link — that link is site-wide navigation, not a per-feature confirmation. Revisit if/when Exabeam documents one. |
| Context Tables / lookup tables | [Context Management admin guide](https://docs.exabeam.com/context-management) | Every documented onboarding path is a **per-vendor pull connector** (Google Workspace, CrowdStrike, Anomali, Recorded Future, STIX/TAXII) — not a generic named/typed lookup-table CRUD API like Splunk or Google SecOps expose. No `context-management`/`context-tables` API reference page was found under any convention-matched slug. |
| Watchlists / notable entities | — | No API reference page found under any convention-matched slug. Not confirmed to exist as a New-Scale REST resource. |
| RBAC roles / API key management | [Universal RBAC guide](https://docs.exabeam.com/en/exabeam-soc-platform/all/administration-guide/universal-role-based-access.html); only `/auth/v1/token` confirmed under "Identity and Access" | No roles/API-keys REST endpoints found. Also self-referential the way `ping-identity` excludes worker-app management: this app's own connection IS an API Key, so managing keys here risks locking out the connection itself. |
| Log sources / collectors (Cloud & Site Collectors) | [Log Sources guide](https://docs.exabeam.com/log-sources) | Documented purpose is **monitoring** ("detect active and inactive log sources"), not configuration; no parser/collector-config REST surface found. |
| Custom parsers | — | No `parsers` API reference page found under any convention-matched slug; the Log Sources guide makes no mention of parser configuration at all. |
| Automation Management (playbooks / actions / services) | [Automation Management guide](https://docs.exabeam.com/automation-management); [Action Editor guide](https://docs.exabeam.com/action-editor) | SOAR-style content authored via the console's UI/Python-file editor (`__init__.py`, `connector.py`); no REST API referenced or found. |
| Threat Scoring (risk-score weighting) | [Threat Scoring guide](https://docs.exabeam.com/en/threat-detection-management/all/threat-detection-management-guide/threat-scoring.html) | Documented as an output (a computed 1–100 risk score), not an admin-configurable input; no tuning API found. |
| Notification / alert routing settings | — | No standalone notification-settings resource found; the closest concept — a rule's trigger action (alert / email / case) — lives *inside* `sequencesConfig.outcomes`, i.e. it's already covered as part of Correlation Rules rather than being a separate type. |
| Service Health and Consumption | Referenced in the changelog | Read-only metrics/telemetry endpoint — no config to declare. |

Every exclusion above was checked by fetching the actual `developers.exabeam.com/exabeam/reference/*`
page for each convention-matched endpoint slug (confirming either real content or a genuine HTTP 404),
cross-referenced against the `docs.exabeam.com` admin guides where the feature is described. Nothing
in this app was invented or guessed at the wire-format level — every field this app sends was read off
a live reference page's documented request/response schema.

## Health check

The Correlation Rules API exposes no lighter "ping"/whoami endpoint, so the health check's
reachability probe is the same `GET /correlation-rules/v2/rules` list call driftDetect and deploy
already use (a 401/403 means the API Key was rejected) — deliberately not a separate round-trip, to
respect Exabeam's documented rate limits.

## References

- Exabeam API developer portal: <https://developers.exabeam.com/>
- Correlation Rules API reference (create): <https://developers.exabeam.com/exabeam/reference/correlation-create-rule>
- Authentication guide (API keys, token lifetime, rate limits): <https://developers.exabeam.com/exabeam/docs/api-keys>
- New-Scale Security Operations Platform docs: <https://docs.exabeam.com/new-scale-security-operations-platform/>
- Threat Detection Management guide: <https://docs.exabeam.com/threat-detection-management>
