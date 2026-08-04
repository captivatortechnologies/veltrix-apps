# SonarQube (Veltrix app)

Manage **SonarQube as code**. Author quality gates, quality profiles (with
per-rule overrides), webhooks, permission templates, global settings, new
code periods, global permissions and ALM (DevOps Platform) settings in the
Veltrix Configuration Canvas and drive them through the Security-as-Code
pipeline: **validate → deploy → health check → drift detection → rollback**.
Everything is applied over the **SonarQube Web API**. A dedicated
**Infrastructure** page can also provision and manage a BYOL SonarQube stack
end to end.

Category: **COMPLIANCE**. App id: `sonarqube`.

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **Quality Gates** | Create/edit quality gates and reconcile their conditions; optionally set the org default | `/api/qualitygates/*` |
| **Quality Profiles** | Create profiles; set language, parent (inheritance), default flag and bulk-activated rule keys | `/api/qualityprofiles/*` |
| **Quality Profile Rule Overrides** | An explicit severity, parameter values and/or "prioritized rule" flag for one rule in one profile | `/api/qualityprofiles/activate_rule`, `/deactivate_rule`, `/api/rules/search` |
| **Webhooks** | Create/update global or project webhooks, with an optional HMAC secret | `/api/webhooks/*` |
| **Permission Templates** | Create/edit templates and reconcile their group grants | `/api/permissions/*_template` |
| **Global Permissions** | Grant instance-wide permissions to groups directly (not via a template) | `/api/permissions/add_group`, `/remove_group`, `/groups` |
| **Global Settings** | Arbitrary instance-wide `sonar.*` properties — a single value or a multi-value list | `/api/settings/set`, `/reset`, `/values` |
| **New Code Periods** | The New Code baseline (previous version / number of days / reference branch / specific analysis) at the global, project or branch level | `/api/new_code_periods/*` |
| **ALM Settings** | Instance-level DevOps Platform Integration connections (GitHub, GitLab, Bitbucket Server/Cloud, Azure DevOps) | `/api/alm_settings/*` |

See **Coverage** below for the full inventory of what SonarQube's Web API
exposes and why each excluded surface was left out.

### Quality Gates

A quality gate is authored as:

- **Name** — the gate's identity (used for upsert and drift).
- **Set as default** — make this the organization's default gate.
- **Conditions** — one per line, `<metric> <LT|GT> <threshold>`. Examples:

  ```
  new_coverage LT 80
  new_duplicated_lines_density GT 3
  new_reliability_rating GT 1
  ```

  `LT` fails when the value is lower than the threshold; `GT` fails when greater.
  SonarQube allows **one condition per metric per gate**, so conditions are
  reconciled by metric (create new, update changed, delete removed). Lines starting
  with `#` are ignored.

### Quality Profiles / Rule Overrides

A quality profile's identity is the **(name, language)** pair. `Quality
Profiles` bulk-activates a flat list of rule keys at each rule's *default*
severity (`activateRuleKeys`, one `<repository>:<rule>` per line). `Quality
Profile Rule Overrides` is the companion type for when a rule needs an
*explicit* severity, parameter values (`key=value` per line) or a
"prioritized rule" flag — it addresses one `(profile, rule)` pair at a time
via SonarQube's singular `activate_rule`/`deactivate_rule` actions, never
touching a rule it didn't itself declare. If both config types touch the same
rule, whichever deploys last wins — a documented interaction, not a bug.

### Webhooks

A webhook is a name (identity within its scope), a delivery URL, an optional
HMAC secret, and a global-or-project scope (blank project = global).
SonarQube never returns a secret's value (only whether one is set), so a
secret can be set/updated but never diffed for drift nor restored on
rollback.

### Permission Templates / Global Permissions

`Permission Templates` manages named templates (name, description, a
project-key-pattern regex, and group grants) that auto-apply to matching
*new* projects. `Global Permissions` instead grants permissions **directly**,
right now, at the instance level — a group name plus a list of global
permissions (`admin`, `gateadmin`, `profileadmin`, `provisioning`, `scan`,
`applicationcreator`, `portfoliocreator`). Both reconcile only the groups you
declare; every other grant is left untouched.

### Global Settings

Any `sonar.*` instance-wide property, authored as a key and either a single
**Value** or a multi-line **Values** list (exactly one of the two). Global
scope only — `component` is never sent. SonarQube's PROPERTY_SET settings
(`fieldValues`, e.g. a custom email template's per-row fields) are out of
scope: their field schema differs per setting and isn't practical to model
generically.

### New Code Periods

The baseline SonarQube uses to compute *New Code* metrics, at the **global**
level (leave project/branch blank), a **project** level, or a **branch**
level (both project and branch set). Type is one of `PREVIOUS_VERSION`,
`NUMBER_OF_DAYS` (1–90), `REFERENCE_BRANCH` (project/branch only, not
global), or `SPECIFIC_ANALYSIS` (branch only — validate.ts always warns that
analysis ids are ephemeral, since SonarQube purges old analyses over time).

### ALM Settings

An instance-level DevOps Platform Integration — GitHub, GitLab, Bitbucket
Server, Bitbucket Cloud or Azure DevOps — keyed by a unique `key`. Every
credential field (personal access token, client secret, private key, webhook
secret) is write-only, exactly like the Webhooks secret: required when
*creating* a new key, optional on a later deploy (blank leaves the stored
value unchanged), and never readable back for drift or rollback. Changing an
existing key's ALM type is refused rather than silently deleted and
recreated — the prior secrets could never be recovered to make that safe.
Per-project repository bindings and the deprecated project-import actions
(`import_github_project`, etc.) are out of scope — see Coverage.

## Coverage

Researched against the SonarQube Web API's own **live reflection endpoints**
on a running instance — `GET api/webservices/list?include_internals=true`
(the full action/parameter catalogue) and `GET
api/webservices/response_example?controller=..&action=..` (verified response
shapes) — rather than scraped documentation. Several response shapes (the
`api/permissions/groups` group list, the `api/alm_settings/list_definitions`
per-provider grouping, and the `api/rules/search?f=actives` per-rule
activation record) were additionally confirmed by live probe calls against a
real, production-grade SonarQube instance (SonarSource's own public reference
deployment, `next.sonarqube.com`).

### Managed (9 config types)

| SonarQube surface | Config type | Since |
| --- | --- | --- |
| `api/qualitygates` | Quality Gates | 0.1.0 |
| `api/qualityprofiles` (create/inherit/bulk-activate/set-default) | Quality Profiles | 0.2.0 |
| `api/webhooks` | Webhooks | 0.2.0 |
| `api/permissions/*_template` | Permission Templates | 0.2.0 |
| `api/settings` (set/reset/values, global scope) | Global Settings | 0.4.0 |
| `api/new_code_periods` | New Code Periods | 0.4.0 |
| `api/permissions` (add_group/remove_group/groups, global scope) | Global Permissions | 0.4.0 |
| `api/qualityprofiles/activate_rule`, `/deactivate_rule` + `api/rules/search` | Quality Profile Rule Overrides | 0.4.0 |
| `api/alm_settings` (create_*/update_*/delete/list_definitions) | ALM Settings | 0.4.0 |

### Intentionally excluded, with reasoning

| SonarQube surface | Why it's excluded |
| --- | --- |
| `api/settings` `fieldValues` (PROPERTY_SET settings) | Each PROPERTY_SET setting has its own, unpredictable per-occurrence field schema (e.g. a custom email template's rows) — not practical to model as one generic canvas field. Scalar/multi-value settings (the vast majority) are fully covered by Global Settings. |
| `api/permissions` per-**user** grants (`add_user`/`remove_user`, global or project scope) | Group-based RBAC is the standard, auditable pattern SonarQube itself recommends; every login being a potential grant target with no template-style reconciliation story is a much larger, noisier surface. Candidate for a future release. |
| `api/permissions` **project**-scoped grants (`add_group`/`remove_group` with `projectId`/`projectKey`) | Every existing config type in this app is instance-wide (org-level); a per-project permission surface is a different, project-scoped remit this release doesn't take on. |
| `api/alm_settings` per-project bindings (`set_github_binding`, `set_gitlab_binding`, `set_bitbucket_binding`, `set_bitbucketcloud_binding`, `set_azure_binding`, `get_binding`, `delete_binding`) | Project-scoped, not instance-level — a different surface from the ALM connection settings themselves. Candidate for a future release once this app takes on project-scoped config generally. |
| `api/alm_integrations` project-import actions (`import_github_project`, `import_gitlab_project`, `import_bitbucketserver_project`, `import_bitbucketcloud_repo`, `import_azure_project`) | One-shot actions that CREATE a new SonarQube project — not reconcilable declarative state, and marked `DEPRECATED-since=10.5` in the live API. |
| `api/projects` `update_default_visibility` (default visibility for new projects) | Internal-only (`internal: true`) with **no public read-back** — unlike the internal actions this app already relies on elsewhere (e.g. `permissions/template_groups`, `permissions/groups`), which fully round-trip via that same internal endpoint, there is no way to verify the live value for drift detection or capture it for rollback (the only hint is the undocumented `api/navigation/global` payload). Writing a setting this app could never verify or safely revert fails this app's own bar for a manageable config type. |
| `api/views` (Portfolios) and `api/applications` (Applications) | Governance-tier features — Applications require Developer Edition or higher and Portfolios require Enterprise Edition or higher in SonarQube's commercial licensing. This app cannot verify a customer's license tier, and both surfaces (branch selection, project-selection modes, portfolio hierarchies) are substantial, deeply hierarchical config surfaces in their own right — a credible candidate for a dedicated future release, not a same-release addition alongside five other new types. |
| `api/qualityprofiles` `backup`/`restore`/`export`/`copy`/`rename`/`compare` | Operator actions (file-based backup/restore, one-shot copy/rename) rather than declarative state to reconcile. `export`/`exporters`/`importers` are additionally marked `DEPRECATED-since=25.4` in the live API. |
| `api/qualityprofiles` `add_group`/`add_user`/`remove_group`/`remove_user` (who may *edit* a profile) | A profile-level RBAC surface distinct from both the Global Permissions and Permission Templates types (SonarQube-wide permissions) — a candidate for a future, more granular pass over object-level edit rights. |
| `api/rules` (custom rule creation, `create`/`update`/`delete` on user-defined rules) | A different SonarQube surface (rule *authoring*) from rule *activation* (this app's Quality Profiles / Rule Overrides types); custom rules are uncommon and template-driven in a way this release doesn't take on. |
| `api/qualitygates` group/user assignment (who may administer a specific gate) | Same object-level RBAC category as the quality-profile edit-rights surface above — out of scope for this release. |
| `api/user_groups`, `api/users`, `api/user_tokens` | Identity/user-lifecycle administration, not security/quality configuration — typically belongs to the customer's IdP/SCIM provisioning rather than this app's remit. |
| `api/project_analyses`, `api/project_branches`, `api/project_pull_requests`, `api/project_links`, `api/project_tags`, `api/project_badges`, `api/project_dump` | Per-project, mostly read-only or operational (analysis history, badge tokens, dump export) — not instance-wide declarative configuration. |
| `api/issues`, `api/hotspots`, `api/measures`, `api/metrics`, `api/sources`, `api/duplications`, `api/rules` (search/show) | Read-only analysis *output* — findings, measures, source code — not configuration. Nothing to declare or reconcile. |
| `api/ce` (Compute Engine task queue), `api/monitoring`, `api/system`, `api/server`, `api/plugins`, `api/editions` | Server/runtime operational surfaces (background task status, health/monitoring, plugin and edition management) — administered directly on the instance, not declarative security/quality config. |
| `api/audit_logs`, `api/regulatory_reports`, `api/security_reports`, `api/governance_reports` | Read-only reporting/export surfaces (some Enterprise-tier). Nothing to configure. |
| `api/scim_management`, `saml`, `api/github_provisioning` | Identity-federation/provisioning wiring that is itself credential/secret-adjacent infrastructure — the customer's SSO/SCIM setup, not a security-config surface this app should own. |
| `api/notifications`, `api/favorites`, `api/dismiss_message`, `api/l10n`, `api/languages`, `api/push`, `api/navigation`, `api/analysis_cache`, `api/analysis_reports`, `api/developers`, `api/emails`, `api/features`, `api/support` | Per-user UI preferences, informational/reference data, or internal plumbing — not configuration surfaces at all. |

No stub handler, empty declaration, or guessed request shape is shipped for
anything listed above — each is a deliberate, documented scope decision.

## Connecting

1. **API token** — in SonarQube, **My Account → Security**, generate a token whose
   user holds the permissions needed for the config types you plan to manage
   (**Administer Quality Gates**, **Administer Quality Profiles**,
   **Administer System**, etc. — SonarQube's own per-action permission
   requirements are noted in each config type's Web API reference). Store it
   as a Veltrix credential (API token field).
2. **Connection** — on the **Connections** page, add a connection pointing at your
   SonarQube URL (`https://sonarqube.example.com`, or `http://host:9000`) and attach
   the token. **Test** verifies reachability + auth.
3. **Author & deploy** — open the Configuration Canvas, pick a configuration type, add
   your items, and deploy.

### Authentication

SonarQube authenticates with a **token**. The app sends it as **HTTP Basic with the
token as the username and an empty password** (`Authorization: Basic base64("<token>:")`),
which works on every SonarQube version. Newer servers (9.x+) additionally accept the
**bearer** scheme (`Authorization: Bearer <token>`). No username is required.

- **Base URL:** `<host>/api` (e.g. `https://sonarqube.example.com/api/qualitygates/list`).
- **Connectivity:** `GET /api/system/status` (unauthenticated; returns `{ id, version, status }`)
  and `GET /api/authentication/validate` (returns `{ valid: true }`).
- **TLS:** self-signed certificates are tolerated (self-hosted SonarQube is commonly
  behind one). The `verify_tls` setting is present for future enforcement.

> API paths/parameters follow the documented SonarQube Web API and should be verified
> against your SonarQube version. Older servers used `gateId` where current servers use
> `gateName` on condition endpoints; this app uses `gateName`.

## Layout

```
apps/sonarqube/
  manifest.yaml
  lib/sonarqubeApi.ts                              # token Basic-auth REST seam (http/https, self-signed tolerated, form-encoded writes incl. repeated array params)
  config-types/quality-gates/                      # canvas + defaults + validate/deploy/rollback/healthCheck/driftDetect/getStatus + tests
  config-types/quality-profiles/                   # ditto — profiles + bulk rule activation
  config-types/quality-profile-rule-overrides/      # ditto — per-rule severity/param/prioritized overrides
  config-types/webhooks/                           # ditto — global/project webhooks
  config-types/permission-templates/                # ditto — named templates + group grants
  config-types/global-permissions/                  # ditto — direct instance-wide group permission grants
  config-types/global-settings/                     # ditto — arbitrary sonar.* properties
  config-types/new-code-periods/                    # ditto — New Code baseline at global/project/branch level
  config-types/alm-settings/                        # ditto — GitHub/GitLab/Bitbucket/Azure DevOps connections
  infra/spec.ts                                     # BYOL InfraSpec (declarative, generic OpenTofu modules)
  lib/byol*.ts, lib/db/                              # BYOL topology/placement/plan-diff + app-owned tables
  server/index.ts                                   # /meta, /settings, /byol routes
  handlers/testConnection.ts                        # connectivity test
  hooks/                                            # onInstall / onUninstall
  client/                                           # Overview / Setup Guide / Infrastructure / Connections pages
```

## Development

```
cd apps/sonarqube
node node_modules/typescript/bin/tsc --noEmit           # typecheck
node ../../scripts/test-apps.mjs sonarqube              # run handler tests
node ../../scripts/validate-app.mjs apps/sonarqube       # validate against the app contract
```

## Roadmap

- Per-user permission grants (global and project-scoped) and per-project ALM
  repository bindings — see Coverage above.
- Portfolios / Applications (Governance-tier, license-gated) — see Coverage
  above.
- Object-level RBAC (who may edit a specific quality profile or administer a
  specific quality gate).
