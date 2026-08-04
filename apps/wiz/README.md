# Wiz (Veltrix app)

Manage [Wiz](https://www.wiz.io) (CNAPP / cloud security) configuration as code
through the **Wiz GraphQL API**, driven by the Veltrix Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | Wiz object | GraphQL operations |
| --- | --- | --- |
| **Wiz Service Accounts** (`wiz-service-accounts`) | Service accounts | `serviceAccounts` (list), `createServiceAccount`, `deleteServiceAccount` |
| **Wiz Cloud Configuration Rules** (`wiz-cloud-config-rules`) | Custom cloud configuration (CSPM) rules | `cloudConfigurationRules` (list), `cloudConfigurationRule` (read), `createCloudConfigurationRule`, `updateCloudConfigurationRule`, `deleteCloudConfigurationRule` |
| **Wiz Automation Rules** (`wiz-automation-rules`) | Notification / remediation rules | `automationRules` (list), `automationRule` (read), `createAutomationRule`, `updateAutomationRule`, `deleteAutomationRule` |
| **Wiz Reports** (`wiz-reports`) | Graph-query reports | `createReport`, `updateReport`, `deleteReport` |
| **Wiz Security Frameworks** (`wiz-security-frameworks`) | Compliance/policy frameworks | `securityFrameworks` (list), `securityFramework` (read), `createSecurityFramework`, `updateSecurityFramework`, `deleteSecurityFramework` |
| **Wiz Controls** (`wiz-controls`) | Custom Controls (Security Graph query + severity) | `controls` (list), `control` (read), `createControl`, `updateControl`, `deleteControl` |
| **Wiz Host Configuration Rules** (`wiz-host-config-rules`) | Custom host/OS-assessment (OVAL) rules | `hostConfigurationRules` (list), `hostConfigurationRule` (read), `createHostConfigurationRule`, `updateHostConfigurationRule`, `deleteHostConfigurationRule` |
| **Wiz Integrations** (`wiz-integrations`) | Webhook/Slack/Jira/ServiceNow/PagerDuty/... integrations | `integrations` (list), `createIntegration`, `updateIntegration`, `deleteIntegration` |
| **Wiz SAML Identity Providers** (`wiz-saml-identity-providers`) | SSO identity providers + group role mappings | `samlIdentityProviders` (list), `samlIdentityProvider` (read), `createSAMLIdentityProvider`, `updateSAMLIdentityProvider`, `deleteSAMLIdentityProvider` |
| **Wiz Projects** (`wiz-projects`) | Cloud account/organization/Kubernetes-cluster grouping | `projects` (list), `project` (read), `createProject`, `updateProject` (no delete — archive only) |

Every configuration type reconciles by **name** (Controls/Host Configuration
Rules/Cloud Configuration Rules/Security Frameworks against non-builtin
objects only) and targets a `wiz-tenant` component. See **Coverage** below for
what was verified vs. inferred, and what was deliberately left out.

### Service accounts — write-only secret

The client secret Wiz generates for a new service account is returned **once**
and cannot be re-read. This app therefore **creates missing** service accounts
and **leaves existing ones untouched** (it never mutates or re-creates an
account). The generated secret is deliberately **never** requested, stored,
diffed, or logged — only the non-sensitive `clientId` is surfaced. Rotate the
secret in Wiz to obtain a usable value.

### Cloud configuration rules

Each rule evaluates a cloud resource (`targetNativeTypes`, e.g. `aws.s3.bucket`)
against a **Rego (OPA)** policy, with optional Infrastructure-as-Code scanning
via an IaC matcher (Terraform, CloudFormation, Kubernetes, …). Reconciliation
matches **non-builtin** rules only — built-in Wiz rules are never modified. An
updated rule's prior state is captured for rollback.

### Controls — `enabled` is create-time-blind, `project_id` is create-time-only

A Control pairs a Security Graph query (`query`) with a `scope_query` and a
severity: every result opens an Issue. Two verified API quirks shape this
type's behavior:

- **`createControl` does not accept `enabled`** — every new control is
  created enabled regardless of what you declare. Deploy detects a
  declared-disabled new control and issues an immediate follow-up
  `updateControl` to correct it.
- **`project_id` has no update path** — `UpdateControlPatch` has no project
  field. Changing a control's declared project after creation is reported as
  drift but is **never auto-corrected**; delete and recreate the control to
  change its project scope. Wiz also never reflects a `"*"` (all projects)
  scope back on read (`scopeProject` comes back empty) — this is handled so
  it doesn't look like permanent drift.

Reconciliation matches by name across **all** controls the credential can
see — Controls have no verified `builtin` flag in this app's research (unlike
Cloud/Host Configuration Rules and Security Frameworks), so give a managed
control a name that won't collide with a built-in Wiz control or one
auto-generated from a Cloud Configuration Rule's "Function As Control".

### Host configuration rules — the host/OS counterpart to Cloud Configuration Rules

Each rule evaluates a host's configuration against an **OVAL** (Open
Vulnerability and Assessment Language) definition instead of a cloud resource
against Rego — the same policy language behind Wiz's built-in CIS-benchmark
host rules. Reconciliation matches **non-builtin** rules only, the same as
Cloud Configuration Rules. **Operate this type with a little more caution**
than the rest of the app: the mutation's input/output shape is fully verified
against the generated Wiz SDK types, but the reference implementation used to
verify every other type in this app never wired this one into a working
resource (see Coverage below) — treat a deploy error here as a signal to
check current Wiz entitlements before assuming a bug in this app.

### Integrations — the objects automation-rule actions deliver to

Manages the 11 Wiz integration types that are creatable through the API
(Webhook, Slack, Slack Bot, AWS SNS, Azure Service Bus, GCP Pub/Sub,
PagerDuty, Jira, ServiceNow, Opsgenie, ClickUp) through one generic
`createIntegration` / `updateIntegration` mutation set keyed by a `type` enum
— Wiz's real schema is not one mutation per vendor. These are exactly the
objects `wiz-automation-rules`' action `integration_id` field references, so
this type closes a real gap: previously, an automation rule managed by this
app could only point at an integration created by hand in the Wiz console.

Every vendor's own credential (a Jira password/PAT, a ServiceNow
password/OAuth secret, a Slack incoming-webhook URL, a PagerDuty integration
key, …) is embedded directly in the mutation — Wiz has no separate credential
store to reference instead. Every such canvas field is `password`-typed:
**write-only**, never read back, never compared by drift — matching this
app's established secret convention (see Service Accounts above, and
apps/orca-security's notification-integrations for the same pattern applied
elsewhere in this codebase). Because the params can't be safely assumed to
echo secrets back on read, rollback of an *updated* integration restores from
`ctx.previousConfig` — what this app itself declared on the previous
deploy — rather than a live API read.

### SAML identity providers

Manages SAML SSO identity providers and their group-to-role mappings. The
signing `certificate` field is the IdP's **public** key (used by Wiz to
verify assertions) — not a secret — and is treated as an ordinary field,
diffed by drift like any other. `allow_manual_role_override` must be enabled
whenever `use_provider_managed_roles` is disabled (otherwise Wiz has no way
to assign a role to a user); this app validates that combination.

### Projects — no delete API, `is_folder` is create-time-only

A Project groups cloud accounts/organizations/Kubernetes clusters, owners and
a risk profile for issue/finding scoping and reporting. Two verified API
realities shape this type's rollback behavior:

- **Wiz has no `deleteProject` mutation** (verified absent from the schema —
  every other type in this app has one) — a project can only be **archived**
  (`archived: true`). Rollback of a project this app *created* therefore
  archives it and renames it to its own (app-generated) slug — the exact
  pattern Wiz's own tooling uses to "delete" a project, since project names
  are unique tenant-wide and an archived project must free its name to be
  reusable.
- **`is_folder` is create-time only** — `UpdateProjectPatch` has no such
  field, so it is never sent on update.
- Every update is a **full replace** (`UpdateProjectInput.override`, not a
  sparse patch) — Wiz's own schema requires this to correctly nullify removed
  resource links — and always requires the project's own `slug`. Deploy reads
  the live project first specifically to capture it.

The nested cloud-account / cloud-organization / Kubernetes-cluster links are
authored as one JSON blob (`resource_links_json`) rather than typed fields,
following this app's "typed scalars, JSON blob for a deeply-nested long tail"
convention — each link type carries its own nested resource tags/groups.

## Authentication

OAuth2 **client credentials**. Create a service account in Wiz
(**Settings → Service Accounts**, *Custom Integration (GraphQL API)*) with the
scopes this app needs, then store it as a Veltrix credential:

- **Username** → the Wiz service account **Client ID**
- **API token** → the Wiz service account **Client Secret**

The app exchanges these for a short-lived Bearer token at the tenant's auth
endpoint (`https://auth.app.wiz.io/oauth/token`, audience `wiz-api`; legacy
tenants use `https://auth.wiz.io/oauth/token`, audience `beyond-api` — derived
automatically from the **Auth Endpoint** setting).

## Component

Register a `wiz-tenant` component whose **hostname** is your regional Wiz API
host (find it in Wiz under **Settings → Tenant**), e.g. `api.us17.app.wiz.io`.
GraphQL requests go to `https://<host>/graphql`.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `auth_endpoint` | `https://auth.app.wiz.io/oauth/token` | Wiz OAuth2 token endpoint (audience derived from the host). |
| `request_timeout_seconds` | `30` | Per-request timeout for token + GraphQL calls. |

## Development

```
cd apps/wiz
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs wiz            # run handler tests
node ../../scripts/validate-app.mjs apps/wiz    # validate against the app contract
```

## Coverage (v1.3.0)

Coverage was audited against the **generated Wiz GraphQL SDK type surface** —
`internal/wiz/structs.go` (2,648 lines) and `internal/wiz/enums.go` (714
lines) from **terraform-provider-wiz**
(github.com/AxtonGrams/terraform-provider-wiz, the only publicly available,
schema-derived reference implementation of Wiz's write API) — plus, for every
mutation that provider actually ships as a working resource, the **literal
GraphQL query/mutation text** it sends (`internal/provider/resource_*.go`).
Every new type's canvas.yaml and deploy.ts cite exactly which parts are
directly verified vs. inferred by this schema's own repeated conventions.

### Managed declarative tenant configuration

| Configuration type | GraphQL operations | Verification tier |
| --- | --- | --- |
| Service accounts | `createServiceAccount`, `deleteServiceAccount` | Verified (shipped resource) |
| Cloud configuration rules | `cloudConfigurationRules`/`cloudConfigurationRule`, `create/updateCloudConfigurationRule` | Verified (shipped resource) |
| Automation rules | `automationRules`/`automationRule`, `create/updateAutomationRule` | Verified (shipped resource) |
| Reports (GRAPH_QUERY) | `createReport`, `updateReport` | Verified (shipped resource) |
| Security frameworks | `securityFrameworks`/`securityFramework`, `create/updateSecurityFramework` | Verified (shipped resource) |
| Controls | `control`, `create/updateControl`, `deleteControl` | Verified (shipped resource) for create/update/delete/read; `controls` list inferred from the schema's `ControlFilters` input + this schema's repeated plural-list/singular-by-id convention |
| Host configuration rules | `hostConfigurationRules` (list, verified — backs a shipped data source); `hostConfigurationRule`, `create/updateHostConfigurationRule`, `deleteHostConfigurationRule` | List verified; CRUD verified by input/output **type shape only** — defined in the reference SDK but never wired into a working resource there |
| Integrations | `create/updateIntegration`, `deleteIntegration` (generic, `type`-keyed) | Verified by input/output type shape (`CreateIntegrationInput`/`CreateIntegrationParamsInput`); `integrations` list inferred |
| SAML identity providers | `samlIdentityProvider`, `create/updateSAMLIdentityProvider`, `deleteSAMLIdentityProvider` | Verified (shipped resource) for create/update/delete/read; `samlIdentityProviders` list inferred |
| Projects | `project`, `createProject`, `updateProject` (`override`) | Verified (shipped resource); confirmed **no** `deleteProject` mutation exists |

"Inferred" list queries all follow one convention this schema uses
consistently and this app already relies on for three *already-shipped*
production types (`cloudConfigurationRule(s)`, `securityFramework(s)`,
`hostConfigurationRule(s)`): a plural `Connection` query (`nodes` +
`pageInfo`) alongside a singular `type(id: ID!)` read. If an inferred query
doesn't resolve, deploy fails with a clear GraphQL error — it never silently
misbehaves.

### Intentionally excluded

- **Cloud-account connectors** (`createConnector` — AWS/GCP/Azure/...). The
  `authParams` input is inherently vendor-varying **secret/credential
  material** (GCP service-account keys, Azure client secrets, AWS IAM role
  trust policies with external-id validation) and onboarding a cloud account
  is fundamentally a guided, connectivity-verified wizard flow — not a flat
  declarative JSON blob suited to a Security-as-Code canvas item. This
  belongs to Veltrix's dedicated cloud-credential management subsystem, not
  this app.
- **`wiz_control_associations` / `wiz_host_config_rule_associations` /
  `wiz_cloud_config_rule_associations`** (mapping an existing control/rule to
  security sub-categories). Redundant: every owning object
  (Controls/Cloud/Host Configuration Rules) already accepts the identical
  mapping inline via its own `securitySubCategories` field, verified in each
  object's own `Create*Input`. A separate association-only type would just be
  a second, conflicting way to write the same edge.
- **Issue exceptions and saved (Security-Graph-query) filters.** Verified
  **absent** from the 3,300+ lines of generated SDK types covering every
  other mutation-capable object referenced by this app (including several,
  like Projects/Controls/Integrations/SAML/Connectors/Users, that this app
  doesn't even manage) — no `Exception`, `Exclusion`, `SavedFilter`, or
  `IssueSetting`-type create/update/delete mutation exists anywhere in that
  surface. These appear to be UI-only conveniences with no public write
  mutation, not an oversight in this app's research.
- **CI/CD scan policies** (`createCICDScanPolicy` — IaC/secrets/vulnerability
  disk-scan thresholds for pipeline integrations). Genuinely declarative and
  API-manageable, but governs build-time pipeline scanning behavior rather
  than the tenant's runtime cloud/host security posture every other type in
  this app manages — deferred to keep this pass scoped to tenant
  configuration; a reasonable candidate for a future release.
- **Wiz platform users** (`createUser` — who can log into Wiz, and with what
  role). Tenant identity/access administration, not CNAPP security-posture
  configuration — the same category boundary this app already draws around
  Wiz Service Accounts (a *machine* identity used only to authenticate this
  app, never touching human user provisioning). A candidate for a dedicated
  future type if ever prioritized, likely alongside SAML group-mapping role
  assignment.
- **Findings, Issues, vulnerabilities, inventory/resources, cloud account
  connection status, and the audit log itself** (beyond its use for drift
  **attribution**) remain out of scope as runtime/read-only data, consistent
  with every prior release of this app.

Primary references: [Wiz product documentation](https://www.wiz.io/) and
[terraform-provider-wiz](https://github.com/AxtonGrams/terraform-provider-wiz)
(`docs/resources/*.md`, `internal/provider/resource_*.go`,
`internal/wiz/structs.go`, `internal/wiz/enums.go`) — the schema-derived
reference this release's research was built on.
