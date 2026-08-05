# Prisma Cloud

Manage **Palo Alto Prisma Cloud (CSPM)** configuration as code through the Prisma
Cloud REST API, with validation, drift detection and rollback handled by the
Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | Prisma Cloud endpoint(s) | Identity |
| --- | --- | --- |
| **Compliance Standards** | `/compliance` | Name |
| **Compliance Requirements** | `/compliance/{standardId}/requirement` | requirementId |
| **Compliance Sections** | `/compliance/requirement/{requirementId}/section` | sectionId |
| **Account Groups** | `/cloud/group` | Name |
| **Roles** | `/user/role` | Name |
| **Resource Lists** | `/resource_list` | Name |
| **Saved Searches** | `/search/history` (RQL) | Client-supplied UUID |
| **Custom Policies** | `/policy`, `/v2/policy` | Name |
| **Login IP Allow Lists** | `/ip_allow_list_login` | Name |
| **Permission Groups** | `/permission` | Name |
| **Collections** | `/collection` | Name |
| **Alert Rules** | `/v2/alert/rule` | Name |
| **Anomaly Trusted Lists** | `/anomalies/trusted_list` | Name |
| **Trusted Alert IPs** | `/allow_list/network` | Name |
| **Notification Templates** | `/api/v1/tenant/notification-templates` | Name |
| **Reports** | `/report` | Name |
| **Enterprise Settings** | `/settings/enterprise` | Singleton |
| **Users** | `/v2/user`, `/user/{email}` | Email |
| **Integrations** | `/integrations` | Name |
| **Anomaly Settings** | `/anomalies/settings/{policyId}` | policyId (built-in) |

Every type is matched by a **name (or other natural identity), not a live
lookup** — Prisma Cloud has no "find by name" endpoint for most of these
resources, so this app lists and matches client-side, storing the
server-assigned id for rename-safety. Built-in / system-default objects
(standards, requirements, sections, policies, permission groups) are always
protected — this app never modifies or deletes them. Reconcile only ever
deletes objects **this app created** and no longer declares. See **Coverage**
below for the full endpoint-by-endpoint audit, what's excluded and why.

## Authentication

Prisma Cloud authenticates with an **access key**. In **Settings > Access Control
> Access Keys**, create a key (ideally for a service account with a role that can
manage the resources above). Store the credential as:

- **Username** → the Access Key ID
- **Password** → the Secret Key

Set the app's **API URL** to your tenant's API host (e.g.
`https://api.prismacloud.io`; regions differ — `api2`, `api.eu`, `api.anz`,
`api.gov`, …). The app logs in (`POST /login`) for a short-lived JWT sent as the
`x-redlock-auth` header, re-logging in automatically when it expires.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs prisma-cloud

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/prisma-cloud
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## Coverage (v0.6.0)

Coverage was audited against the Prisma Cloud CSPM API reference
([pan.dev/prisma-cloud/api/cspm](https://pan.dev/prisma-cloud/api/cspm/)) and,
for the endpoints pan.dev's rendered explorer doesn't expose a full body
schema for, the authoritative per-resource OpenAPI JSON specs published in
[`PaloAltoNetworks/pan.dev`](https://github.com/PaloAltoNetworks/pan.dev)
(`openapi-specs/cspm/*.json`) — cross-checked against
[`PaloAltoNetworks/terraform-provider-prismacloud`](https://github.com/PaloAltoNetworks/terraform-provider-prismacloud),
whose own resource set is a strong "is this genuinely safe, stable, and
declarative" signal (a Terraform resource that doesn't exist for something is
often evidence the underlying API doesn't support it cleanly, not an
oversight). The Compute (CWPP) and Data Security (DSPM) surfaces were also
researched — see below for why they stay out of scope.

### Managed declarative configuration

| Configuration type | CSPM API | Notes |
| --- | --- | --- |
| Compliance Standards | `GET`/`POST /compliance`, `PUT`/`DELETE /compliance/{id}` | Custom standards only; built-in protected |
| Compliance Requirements | `/compliance/{standardId}/requirement` | Under a custom standard |
| Compliance Sections | `/compliance/requirement/{requirementId}/section` | Under a custom requirement |
| Account Groups | `/cloud/group` | Auto-created groups protected |
| Roles | `/user/role` | `roleType` = built-in type or custom Permission Group name |
| Resource Lists | `/resource_list` | TAG / RESOURCE_GROUP / COMPUTE_ACCESS_GROUP |
| Saved Searches | RQL saved search endpoints | Dependency for Config/IAM/Network/Audit custom policies |
| Custom Policies | `/policy`, `/v2/policy`, `PATCH /policy/{id}/status` | `systemDefault` policies protected |
| Login IP Allow Lists | `/ip_allow_list_login` | Distinct from Trusted Alert IPs below |
| Permission Groups | `/permission` | Custom only; Default/Internal protected |
| Collections | `/collection` | Asset scoping by account groups/accounts/repos |
| Alert Rules | `/v2/alert/rule` (scan configs) | Policy selection + target scope + notification states |
| Anomaly Trusted Lists | `/anomalies/trusted_list` | Suppression entries for anomaly alerts |
| Trusted Alert IPs | `/allow_list/network` ("public networks") | Distinct resource from Login IP Allow Lists |
| Notification Templates | `/api/v1/tenant/notification-templates` | jira/service_now need an `integrationId` |
| Reports | `/report` | Definition/schedule only, never the generated artifact |
| Enterprise Settings | `/settings/enterprise` | Singleton, GET-merge-PUT of declared fields |
| **Users** *(new in v0.6.0)* | `/v2/user`, `/user/{email}` | Matched by email; no password ever set — see below |
| **Integrations** *(new in v0.6.0)* | `/integrations` | Scoped to `aws_security_hub` + `google_cscc` — see below |
| **Anomaly Settings** *(new in v0.6.0)* | `/anomalies/settings/{policyId}` | Built-in policy tuning, distinct from Anomaly Trusted Lists |

**Users.** Matched by **email** — Prisma has no surrogate id for this
resource at all; `GET`/`PUT`/`DELETE` all address a user by email directly.
No password is ever set or read: a new profile is created with **no
credential**, and Prisma emails the user its own setup link — the same
no-secret pattern this catalog already uses for invite-based user
provisioning (e.g. `misp`'s Users type). `enabled` is read-only on the
profile object itself; it's toggled through the separate `PATCH
/user/{email}/status/{enabled}` endpoint. A genuine API asymmetry: the write
model (`POST`/`PUT /v2/user`) accepts a full `roleIds` array + a
`defaultRoleId`, but the read model (`GET /v2/user[/{email}]`) only ever
returns the single active `roleId` — there is no endpoint that returns a
user's complete multi-role assignment. Drift detection and rollback are
scoped to what's actually readable (name, time zone, default role,
access-key permission, enabled); the full `roleIds` set is carried forward
from what this app itself last applied, not re-derived from a live read.

**Integrations.** Prisma Cloud documents **15** integration types
(`api-integration-config.md`); this type is scoped to the **2** with zero
embedded secret material — `aws_security_hub` (region list + AWS account id)
and `google_cscc` (GCP org id + source id). The other 13 (Slack, Splunk,
PagerDuty, webhook, Microsoft Teams, Jira/Cortex XSOAR, ServiceNow, Okta,
Qualys, Tenable, Snowflake, Amazon SQS/S3/Security Lake, Azure Service Bus)
each embed a real API key/token/password/private key in `integrationConfig`,
or (Amazon SQS/S3/Security Lake in IAM-role mode) an `externalId` that
Palo Alto's **own** Terraform provider marks `Sensitive: true`. This app
*does* have a write-only secret field type precedented elsewhere in the
catalog (`fieldType: password`, e.g. `crowdstrike-edr`'s
`cloud-registry-connections` — sent on create/update, never read back,
diffed, or stored in rollback data), so this scoping is a **deliberate,
disciplined choice for this pass** rather than a platform limitation: each
of the other 13 types has a genuinely different `integrationConfig` shape,
and modeling all 15 as one config type in a single pass risked a sprawling,
under-tested resource. A future pass could extend this type-by-type using
the same write-only pattern. `integrationType` is **immutable** after
creation — Prisma's `PUT` update body doesn't accept it at all — so a
live/declared mismatch is flagged as a deploy failure (delete and recreate
under a new name to change type) rather than silently ignored.

**Anomaly Settings.** Distinct from the already-existing Anomaly Trusted
List type: this tunes the **built-in** ML/UEBA anomaly-detection models
themselves (`alertDisposition`, `trainingModelThreshold`) rather than
suppression entries. There is no create/delete — every anomaly policy
already has settings — so this is a GET-merge-POST of only the declared
fields (blank = leave unchanged), the same convention Enterprise Settings
already established. `policyId` is a raw id the caller supplies directly,
consistent with how Anomaly Trusted List's own `applicablePolicies` field
already works in this app (find it via the Policies page filtered to
`policyType=anomaly`, or `GET /v2/policy`) — this app does not resolve
policy names to ids.

### Intentionally excluded

- **Cloud Accounts** (`cloud-accounts-aws/-azure/-gcp/-oci-alibaba`,
  `cloud-accounts-all`) — researched in depth, not built. AWS onboarding is
  the closest to secret-free (`roleArn` + `externalId`), but Palo Alto's own
  Terraform provider (`resource_cloud_account.go`) still marks `external_id`
  `Sensitive: true`, and Azure/GCP/OCI/Alibaba all require a real credential
  in the body (Azure `key`, GCP service-account JSON, etc.). Beyond secrets,
  every cloud type's account "record" is inert without an **out-of-band**
  trust bootstrap the customer must create independently (an AWS
  CloudFormation stack establishing the IAM role's trust policy, an Azure
  App Registration, a GCP service account) — the same
  "foreign/externally-bootstrapped resource" reasoning `cortex-xdr` uses to
  exclude Broker VM management. Palo Alto's own provider needed **four**
  separate resources (`resource_cloud_account`, `resource_v2_cloud_account`,
  `resource_org_cloud_account`, `resource_org_cloud_account_v2`) to cover
  this one conceptual resource across versions/scopes — real, confirmed
  complexity, not a guess. A legitimate candidate for a dedicated future
  pass, scoped per cloud type.
- **Compute (CWPP)** — a genuinely separate product surface with its own API
  dialect. Confirmed via the Compute OpenAPI spec
  (`openapi-specs/compute/34-03/openapi-34-03-138-sh.json` in
  `PaloAltoNetworks/pan.dev`) that it's reachable using the *same*
  CSPM-issued JWT (`x-redlock-auth`) against a separately-resolved Console
  URL — so this isn't a credential-model blocker, but it is a distinct
  resource model, error format, and roughly a second app's worth of surface
  (Policies alone span 12+ singleton GET/PUT endpoints across
  compliance/runtime/WAAS/network policy types for container/host/
  serverless). Two candidates were fully scoped and are safe, precedented,
  and NOT built this pass: **Collections** (`POST`/`PUT`/`DELETE
  /collections[/{name}]`, name-addressed, no secrets — Palo Alto's Terraform
  provider implements this exact resource) and **Custom Rules** were both
  researched; Custom Rules specifically is further excluded because its
  create-and-update path (`PUT /custom-rules/{id}`) requires the caller to
  pick a **globally-unique numeric id** with no id-generator endpoint to
  discover the next one safely — and, tellingly, Palo Alto's own Terraform
  provider does **not** implement a Custom Rule resource at all. Compute
  Policies (container/host/serverless compliance + runtime + WAAS/CNNS + CI)
  were reviewed at the path level but not modeled — their per-type rule
  schemas are individually complex enough (nested behavioral/process/
  network conditions) that guessing field names without full schema
  confirmation would risk shipping incorrect, non-round-trippable code.
- **Data Security (DSPM)** — Data Patterns and Data Profiles (custom
  sensitive-data regex classifiers) looked clean and secret-free when
  researched via Palo Alto's Terraform provider
  (`resource_datapattern.go`/`resource_dataprofile.go`), but DSPM is
  documented by Palo Alto itself as a **third, independent API product**
  alongside CSPM and CWPP (`products/prisma-cloud/api/dspm/` in
  `PaloAltoNetworks/pan.dev`, with its own onboarding, access, and API-key
  flow) — the same "separate product surface" reasoning as Compute above.
- **IAM (CIEM)** — `/get-permissions`, `/search-permissions-v3`,
  `/least-privilege-access-*`, etc. are all read-only cloud-entitlement
  analysis/reporting endpoints, not configuration.
- **Asset Relationship Definitions** — read-only catalog of Prisma's
  supported relationship types between assets; nothing user-creatable.
- **SSO** (`/saml`, `/oauth2` config) — security-sensitive console-login
  bootstrap. A misconfigured IdP mapping can lock every user out of the
  tenant — the same category `cortex-xdr` excludes its own
  `authentication-settings/*` SSO config under.
- **Access Keys** — self-referential: this is the very credential mechanism
  the app authenticates with. Automating the management of the API key that
  authenticates the automation is the same bootstrap-security boundary this
  catalog draws elsewhere (e.g. `cortex-xdr` excludes `api_keys/*`).
- **Code to Cloud** — VCS (GitHub/GitLab/Bitbucket) integration requires an
  OAuth token, GitHub App installation, or personal access token — secret
  material with no non-secret subset.
- **Read-only dashboards, inventory & logs.** Adoption Advisor, Alerts,
  Anomalies (the alert feed, not the trusted list/settings above),
  Applications, Archived Assets, Asset Explorer/Inventory, Audit Logs,
  Background Jobs, Command Center/Widgets, Compliance Posture, Discovery and
  Exposure Management, Licensing, Resource Explorer, Search/Search Manager,
  System, User Profile (the caller's own profile, not the Users type above),
  and Vulnerabilities Dashboard are all reporting/analysis surfaces with no
  meaningful write path.

Primary references: [Prisma Cloud CSPM API](https://pan.dev/prisma-cloud/api/cspm/),
[Prisma Cloud Compute API](https://pan.dev/prisma-cloud/api/cwpp/),
[Integration Configurations](https://pan.dev/prisma-cloud/api/cspm/api-integration-config/),
[`PaloAltoNetworks/pan.dev`](https://github.com/PaloAltoNetworks/pan.dev) (OpenAPI specs),
[`PaloAltoNetworks/terraform-provider-prismacloud`](https://github.com/PaloAltoNetworks/terraform-provider-prismacloud),
and each endpoint cited in the per-type `validate.ts`/`deploy.ts` doc comments.

Apache-2.0.
