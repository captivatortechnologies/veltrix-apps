# Sysdig Secure

Manage **Sysdig Secure** as code across threat detection, notifications,
access/scoping, CSPM posture and vulnerability (image-scanning) management.
Author each configuration in the Configuration Canvas and drive it through
the Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback — over the Sysdig Secure REST API.

Sysdig is SaaS, so there is **no BYOL infrastructure and no app database**.

## What it manages

| Group | Configuration type | Sysdig object | API surface |
| --- | --- | --- | --- |
| Threat Detection | **Falco Rules** | Custom Falco (threat-detection) rules | `/api/secure/rules` |
| Threat Detection | **Runtime Policies** | Custom runtime policies (create/edit/remove) | `/api/v2/policies` |
| Threat Detection | **Falco Lists** | Custom Falco lists | `/api/secure/falco/lists` |
| Threat Detection | **Falco Macros** | Custom Falco macros | `/api/secure/falco/macros` |
| Threat Detection · Managed Policies | **Managed Policies** | Tuning of Sysdig's built-in managed policies | `/api/v2/policies` |
| Notifications | **Notification Channels** | Slack/Email/Webhook/PagerDuty/OpsGenie/MS Teams/SNS/VictorOps/Team Email/Prometheus Alertmanager | `/api/notificationChannels` |
| Access & Teams | **Teams** | Teams — scope, capabilities, zones, members | `/api/teams` |
| Zones | **Zones** | Named, reusable resource scopes | `/platform/v1/zones` |
| Posture (CSPM) | **Posture Controls** | Custom Rego evaluation rules | `/api/cspm/v1/policy/controls` |
| Posture (CSPM) | **Posture Policies** | Compliance policies (requirement groups → requirements → controls) | `/api/cspm/v1/policy` |
| Posture (CSPM) | **Posture Zone Assignments** | Zone ↔ posture-policy assignment (whole-list) | `/api/cspm/v1/zones/{zoneId}/policies` |
| Vulnerability Management | **Vulnerability Rule Bundles** | Pass/fail rules (package/vuln denylist, severity threshold, image-config checks) | `/secure/vulnerability/v1/bundles` |
| Vulnerability Management | **Vulnerability Policies** | Image-scanning policies + stage (pipeline/registry/runtime/admission-control) assignment | `/secure/vulnerability/v1/policies` |

Every type upserts by name (or, for the two CSPM/Vulnerability object families
with no by-name lookup, by an id this app carries forward itself — see
Coverage below) and models a canvas `enabled: false` as "not present" — the
item is removed if it exists — the one exception being **Managed Policies**,
which can never be deleted (Sysdig owns the content), so `enabled: false`
resets it to Sysdig's defaults instead.

## Connection & credentials

A connection is a **Sysdig tenant** addressed by its **region base URL** plus a
**Bearer API token**.

- **Region base URL** — the address of your Sysdig console, e.g.
  `https://us2.app.sysdig.com`. The US-East default is `https://secure.sysdig.com`
  (the same default the official Terraform provider uses). Set it as the
  connection endpoint; the full URL is stored, so any region works.
- **API token** — from **Settings → Sysdig Secure API** in the console, or a
  team-based / global service account. Stored as the credential's API token and
  sent as `Authorization: Bearer <token>`.

The **Test** button on the Connections page runs
`GET /api/secure/rules/groups?type=FALCO` — a 200 confirms the endpoint resolves
and the token authenticates.

## REST API reference — Falco Rules

Custom Falco rules are individual objects under `/api/secure/rules`:

| Operation | Method & path |
| --- | --- |
| Find by name (upsert lookup) | `GET /api/secure/rules/groups?name=<name>&type=FALCO` |
| Create | `POST /api/secure/rules?skipPolicyV2Msg=true` |
| Get by id | `GET /api/secure/rules/<id>` |
| Update | `PUT /api/secure/rules/<id>?skipPolicyV2Msg=true` |
| Delete | `DELETE /api/secure/rules/<id>?skipPolicyV2Msg=true` |

The rule JSON body:

```json
{
  "name": "Unexpected outbound connection",
  "description": "…",
  "tags": ["network"],
  "details": {
    "ruleType": "FALCO",
    "source": "syscall",
    "output": "Netcat run (user=%user.name command=%proc.cmdline)",
    "condition": { "condition": "evt.type=execve and proc.name=nc", "components": [] },
    "priority": "WARNING",
    "append": false
  }
}
```

Deploy upserts by rule **name**: an existing rule is updated (carrying its live
`id` + `version`), a new one is created. `rollbackData` records the action
taken and the prior rule body so rollback can restore, re-create, or remove
precisely. See `lib/sysdigApi.ts` for the endpoints backing every other config
type (each documented at its point of use).

## Coverage (v0.3.0)

Coverage was audited against the official
[`terraform-provider-sysdig`](https://github.com/sysdiglabs/terraform-provider-sysdig)
Go client (`sysdig/internal/client/v2`, the source of truth for the actual REST
contract — the provider's resource docs describe the Terraform-side argument
names, which sometimes differ from the wire JSON), the
[Sysdig API docs](https://docs.sysdig.com/en/developer-tools/sysdig-api/), and
each endpoint's resource/data-source pages under `website/docs/r`.

### Managed declarative configuration

| Configuration type | Endpoints | Identity / upsert strategy |
| --- | --- | --- |
| Falco Rules | `/api/secure/rules` (+ `/groups?name=` lookup) | by name |
| Runtime Policies | `/api/v2/policies` | by name (list-all, no by-name filter) |
| Falco Lists | `/api/secure/falco/lists` (+ `/groups?name=`) | by name |
| Falco Macros | `/api/secure/falco/macros` (+ `/groups?name=`) | by name |
| Managed Policies | `/api/v2/policies` | by name + type, requiring `isDefault === true` (never created/deleted) |
| Notification Channels | `/api/notificationChannels` | by name (list-all, no by-name filter) |
| Teams | `/api/teams`, `/api/users/light` (email→id) | by name |
| Zones | `/platform/v1/zones` (server-side `?filter=name:`) | by name |
| Posture Controls | `/api/cspm/v1/policy/controls` (+ `/view/<id>`) | **no by-name lookup** — id carried via `rollbackData.externalIds` |
| Posture Policies | `/api/cspm/v1/policy`, `/api/cspm/v1/policy/policies/list`, `/api/cspm/v1/policy/posture/policies/<id>` | by name (list-all-with-name IS supported here) |
| Posture Zone Assignments | `/api/cspm/v1/zones/{zoneId}/policies` | by zone name (hard dependency — see below) |
| Vulnerability Rule Bundles | `/secure/vulnerability/v1/bundles` | **no by-name lookup** — id carried via `rollbackData.externalIds` |
| Vulnerability Policies | `/secure/vulnerability/v1/policies` | **no by-name lookup** — id carried via `rollbackData.externalIds`; bundles referenced by numeric id |

**The id-carry pattern.** Posture Controls, Vulnerability Rule Bundles and
Vulnerability Policies expose CRUD-by-id in the official Go client but no
"list all" or "find by name" method — confirmed by reading the client
interfaces (`PostureControlInterface`, `VulnerabilityPolicyClient`,
`VulnerabilityRuleBundleClient`), which only declare `CreateOrUpdate`/
`GetByID`/`DeleteByID`. Rather than guess at an unconfirmed GET-all endpoint,
these three config types use the SDK's own documented mechanism for this
exact situation: `DeployResult.rollbackData` persists a
`{canvas item id → external id}` map, and the next deploy reads it back via
`ctx.platform.getLatestDeployment(canvasId, {status:'SUCCEEDED'})` — matching
the `DeploymentSummary.rollbackData` doc comment ("the external ids it
assigned per canvas item — so the next deploy can match existing objects by
stable id ... instead of by name"). `driftDetect` reads the same map. A
renamed canvas item keeps its external id (the map key is the canvas's own
stable item id, not the declared name); a first-ever deploy, or an item added
after the fact, creates fresh.

**Cross-references.** Several new types reference another by name, resolved
live at deploy time, exactly like the existing Runtime Policies type resolves
Falco rule names:
- Teams → Zones (`zoneNames`, best-effort — an unresolved name is skipped with
  a note in the deploy message, since a team's zone scoping is supplementary)
- Teams → Users (`userRolesJson[].email`, best-effort resolved via
  `/api/users/light`)
- Posture Zone Assignments → Zones + Posture Policies (**hard** dependency —
  an unresolved zone or policy name FAILS the deploy outright; a compliance
  zone silently missing a policy is a security-relevant surprise, unlike an
  optional team-scoping zone)
- Vulnerability Policies → Vulnerability Rule Bundles: referenced by
  **numeric id**, not name — bundles have no by-name API at all (see above),
  so there is nothing to resolve a name against.

### Intentionally excluded

- **Cloud Account / Cloud-Auth onboarding** (`secure_cloud_auth_account` +
  `_component` + `_feature`) — cross-cloud trust-relationship bootstrap
  (delegate IAM roles, EventBridge rule ARNs, cloud-responder Lambda wiring).
  This app has no credential-broker seam for provisioning trust resources
  inside a customer's AWS/GCP/Azure account, and the provider's own docs flag
  the resource as "under rapid development" with inconsistent provider-type
  support between its own basic and response-actions examples. Onboarding a
  cloud account is a one-time, highly cloud-specific bootstrap step, not
  steady-state, idempotent Sysdig-side config-as-code.
- **v2 match-list custom rules** (`secure_rule_container` / `_filesystem` /
  `_network` / `_process` / `_syscall`) — **CONFIRMED DEPRECATED**: the
  provider's own docs state list-matching rule support "was deprecated on
  2025-12-15 and removed on 2026-02-28; the backend now rejects" these
  `ruleType`s, with an explicit migration note to use an equivalent Falco
  condition instead (already covered by the Falco Rules config type).
- **Stateful rule exceptions** (`secure_rule_stateful`) — an append-only
  exception mechanism onto an existing Sysdig-*managed* stateful rule, scoped
  to a single supported source (`awscloudtrail_stateful`). It cannot create or
  fully define a rule, only append one exception tuple to Sysdig's own
  content — too narrow and target-dependent for this app's upsert-by-name
  model.
- **Legacy CSPM Posture Zone** (`/api/cspm/v1/policy/zones`, embedded
  `policyIds` + opaque rules string) — superseded by the unified Zones
  (`/platform/v1/zones`) + Posture Zone Assignment
  (`/api/cspm/v1/zones/{id}/policies`) modeled above. Both the legacy and
  unified resources still exist in the provider; modeling both here would
  create two competing, overlapping scope mechanisms for the same intent.
- **Managed Rulesets** (`secure_managed_ruleset`) — clones a managed policy's
  content into a new, separate persistent object with the exact same tunable
  fields (severity/enabled/scope/actions/disabled_rules/notification_channels/
  runbook) the Managed Policies config type already exposes in-place. Adding
  it would model the same knobs twice under two competing objects with
  unclear precedence when both target the same underlying managed content.
- **Posture / Vulnerability accept-risk** (`secure_posture_accept_risk`,
  `secure_vulnerability_accept_risk`) — a time-bounded waiver against a
  *specific already-detected finding instance*, not a declaration of desired
  state; closer to a finding-triage action than durable config.
- **Zone v2 structured-expression scopes** — Zones in this app use the v1
  rules-string scope API only. The provider's own `secure_zone` doc says v2
  structured `expression` blocks "require the v2 zones API. If the backend
  only exposes the v1 zones API ... expression-based scopes will fail with an
  explicit error", while v1 `rules` strings are broadly supported and cover
  the same intent (organization/account/cluster filters).
- **SSO, custom roles, group mappings, IP filters, agent access keys, the
  Sysdig organization object, and user/service-account management** —
  account/platform-wide administration and auth bootstrap outside this app's
  per-tenant "Sysdig Secure API token" connection boundary, mirroring how
  other Veltrix apps exclude org-wide administration from a
  connection-scoped canvas.
- **Monitor-side alerts, dashboards, silence/inhibition rules and
  notification channels** — a different Sysdig product surface (Monitor, not
  Secure); this app only manages Secure-scoped objects, including the
  Secure-specific flavor of notification channels (`sysdig_secure_notification_channel_*`,
  10 types) rather than the separate Monitor set (which additionally has
  Google Chat, Custom Webhook and IBM Event Notifications — Secure does not).
- **Runtime scans/actions, live findings, events, audit/config-change logs,
  Sysdig Captures, and any other read-only or one-shot imperative surface** —
  not durable desired-state configuration.

## Verification notes

Every new (v0.3.0) endpoint, request/response shape and field name was traced
directly to a specific file in `terraform-provider-sysdig`'s
`sysdig/internal/client/v2` package (the Go client backing the official
Terraform resources) rather than inferred from Terraform argument docs alone,
since Terraform-side names sometimes differ from the wire JSON (for example
the `secure_custom_policy` doc's `failure_action` argument is the
`Configuration.Behaviour` field on the wire, which this app's Vulnerability
Policies type follows). The exact source file is cited in each new config
type's `_shared.ts`/`deploy.ts` header comment. As with the original four
types, verify against a live Sysdig Secure tenant before production use.
