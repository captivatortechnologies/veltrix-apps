# Microsoft Entra ID

Manage Entra configuration through Microsoft Graph and the Veltrix Configuration Canvas. The manifest declares 42 configuration types, covering Conditional Access, directory resources, tenant policies, applications, external identities, branding, and identity governance. Each type supplies validation, deployment, rollback, health, status, and drift handlers. See [manifest.yaml](manifest.yaml) for the current inventory and [IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md) for the prioritized roadmap.

**Coverage:** this is selected Entra configuration management, not complete Entra administration. The [feature coverage audit](FEATURE-COVERAGE.md) maps existing, partial, missing and integration-dependent functionality across Entra ID and the wider Entra family.

The in-app **Setup Guide** walks through registration, consent, credentials, verification, first deployment, and troubleshooting. This README also provides setup instructions for operators working from the repository.

## Prerequisites

- A test Entra tenant, access to app registrations, and an administrator authorized to consent to the selected Microsoft Graph application permissions.
- Veltrix access to app settings, credentials, Connections, and the Configuration Canvas.
- Outbound HTTPS from the handler runtime to `login.microsoftonline.com` and `graph.microsoft.com`. No SSH or ZTNA connection is required.
- Appropriate feature licenses. Conditional Access requires Entra ID P1; risk-based policies require P2. Governance features have separate licensing requirements. See [Microsoft licensing requirements](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview#license-requirements).

The client uses Graph `v1.0` with client secrets, certificate assertions, or an optional platform identity broker. Microsoft cloud settings select allowlisted global, US Government, DoD, or China hosts. Individual feature availability still depends on the cloud. The connection endpoint cannot override these hosts. See [authentication and tenant targeting](AUTHENTICATION.md) for credential formats, broker requirements, and migration instructions.

## Register and authorize an application

1. In the [Entra admin center](https://entra.microsoft.com), find **App registrations**, select **New registration**, and choose accounts in this organizational directory only. This server-to-server flow needs no redirect URI.
2. Copy **Application (client) ID** and **Directory (tenant) ID** from Overview.
3. Under **API permissions > Add a permission > Microsoft Graph > Application permissions**, add only the permissions for the features you will use. Delegated permissions do not authorize this app's client-credentials flow.
4. Have an authorized administrator grant consent for the intended tenant. Confirm the permissions show as granted.
5. Under **Certificates & secrets**, create a client secret. Copy its **Value** immediately, not its Secret ID. Record its expiry and a rotation owner.

### Select permissions by feature

Start with `Organization.Read.All` for the current connection test. For Conditional Access authoring, add `Policy.Read.All` and `Policy.ReadWrite.ConditionalAccess`; add `Group.Read.All`, `User.Read.All`, `RoleManagement.Read.Directory`, and `Application.Read.All` only for the group, user, role, and application references you use. Group management needs `Group.ReadWrite.All` instead of group read alone.

The in-app guide and the generated table below use the same registry for all 42 types. Optional reference permissions apply only to fields and assignment operations you use; some write permissions also authorize reads. Select the combination appropriate to each operation: consult the [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference) and each endpoint's Application permission requirements for your selected operations, related resources, and pickers. Do not grant all profiles or broad directory write access merely to pass Test. [Conditional Access creation requirements](https://learn.microsoft.com/en-us/graph/api/conditionalaccessroot-post-policies?view=graph-rest-1.0) document its permission combination.

**Terms of Use is a current capability limitation.** The manifest exposes agreement management, but its deploy handler first lists agreements. Microsoft documents that [listing agreements](https://learn.microsoft.com/en-us/graph/api/termsofusecontainer-list-agreements?view=graph-rest-1.0) does not support application permissions. This flow therefore cannot complete agreement management, and the picker can fail. Manage agreements in Entra and supply an existing agreement ID in Conditional Access grant controls. Additional application permissions do not fix the unsupported listing.

## Configure Veltrix

| Location | Field | Value |
| --- | --- | --- |
| App settings | Tenant ID (`tenant_id`) | Directory (tenant) ID; a verified domain is also accepted by the client |
| Credential | Username / Application (client) ID | Application ID, not the app registration object ID |
| Credential | Password / Client secret | Client secret **Value**, not Secret ID |
| Connections | Endpoint, if requested | `https://graph.microsoft.com` (informational) |
| App settings | Request Timeout (`request_timeout_seconds`) | Default 30 seconds per request |

Tenant ID is the installation fallback. **Per-connection tenant overrides** (`connection_tenants`) binds a credential ID to its own `tenantId` and optional `cloud`; an unmapped credential retains the fallback. Invalid mappings fail closed. Keep credentials and targets aligned with their effective tenant.

1. Save a connection on **Connections** and attach the credential. The shared connection manager registers an `entra-tenant` deployment target.
2. Choose **Test**. Confirm the displayed tenant name, tenant ID, and client ID.
3. Set **Configuration types to test** (`readiness_features`) to comma-separated IDs, such as `groups,conditional-access-policies`, then run Test for additional read-only feature probes. Open the relevant pickers and validate a test configuration.

**What Test proves:** the handler acquires a token and reads `/organization?$select=id,displayName`. Test verifies the returned organization identity and any selected feature read endpoints. It reports denied and unsupported features separately. It does not verify write access, conditional picker permissions, licensing, or full deployment readiness.

## Make the first deployment

1. Select the intended `entra-tenant` target explicitly in the Configuration Canvas.
2. Deploy prerequisites before dependants: groups, named locations, and custom strengths before Conditional Access policies; catalogs before access packages and assignment policies.
3. Use picker-selected IDs where possible. Display names need not be unique. Cloud-app targets store application IDs (`appId`); service-principal references store directory object IDs (`id`).
4. For Conditional Access, choose a pilot group and explicit applications, retain `report-only`, and select tested emergency-access exclusions. Targeting defaults are intentionally blank.
5. Run validation, review warnings, and deploy. Check the resulting objects in Entra, then run health and drift checks. Health reports endpoint reachability separately from managed-field comparison using the per-type drift handler. Missing, changed, unreadable, ambiguous, and incomplete resources cannot produce a fully verified healthy result. Without desired resources, the result is connectivity only.
6. Inspect report-only sign-in results in Entra before deliberately selecting Enabled. Review Security Defaults compatibility before changing either control.

Report-only is a default, not a forced deployment mode: an explicitly enabled policy is enforced on deployment. Tenant-wide enabled policies require the canvas enforcement acknowledgement; deploy checks that Security Defaults is readable and disabled before writing. Validation reports effective state, targeting, and exclusions for review. A configured exclusion does not prove emergency access works.

Review rollback limits before production changes. The external identity-provider handler cannot restore a prior write-only secret; created custom attribute sets cannot be deleted. These unresolved remnants cause rollback to report failure rather than full restoration. Restore PATCH 404 is a failure; deleting an already absent newly created resource remains idempotent. Agreement operations are gated as unsupported. Keep an independent recovery procedure for irreversible or write-only changes.

## Troubleshooting

| Symptom | Next action |
| --- | --- |
| Missing usable credential | Check Tenant ID, credential username, and secret value are all present. |
| Token failure / status 0 | Read the returned message. Check tenant/client pairing, secret expiry, Value versus Secret ID, DNS, and outbound HTTPS. Status 0 also represents token acquisition errors. |
| Graph 401 or 403 | Check Application permissions and consent for the failing endpoint. `/organization` needs `Organization.Read.All`; a later feature can require additional permissions. Confirm licensing and app-only API support. |
| Test passes but picker or deploy fails | Check the specific resource permissions and referenced objects. Test checks only organization access. |
| Empty picker or unresolved name | Confirm tenant, search text, read permissions, and resource existence. Prefer IDs over ambiguous names. Terms of Use listing is unsupported with this flow. |
| Deploy target unavailable | Save the connection, verify its `entra-tenant` target and credential, and select the target in the canvas. |
| HTTP 429 / timeout | Reduce concurrent work. The client retries 429 once, waiting at most 20 seconds. Check live state before retrying a partial deployment. Adjust the per-request timeout after checking connectivity. |

To rotate credentials, create a replacement secret, update the saved credential, test organization access and a selected feature, then remove the old secret. Store secrets in the credential vault and omit them from logs, screenshots, and canvas fields.

## Development checks

From the repository root, with dependencies already installed:

```powershell
node scripts/validate-app.mjs apps/microsoft-entra-id
node scripts/test-apps.mjs microsoft-entra-id
npm --prefix apps/microsoft-entra-id run typecheck
node scripts/handler-coverage.mjs microsoft-entra-id
npm --prefix apps/microsoft-entra-id run check:client
npm --prefix apps/microsoft-entra-id run check:capabilities
```

The main TypeScript configuration includes the client. Run `check:client` to bundle and exercise the six setup tabs and overview, and `check:capabilities` to detect documentation drift. The default CI TypeScript check includes client pages. Tests use fake HTTP responses; validate real permissions and licensing in a sandbox tenant before release. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md), keep manifest/package versions aligned, and update [CHANGELOG.md](CHANGELOG.md) with every release.

## Configuration type permission reference

This table is generated from [the capability registry](lib/capabilities.ts). Read and write columns list application permission profiles, with additional reference/assignment permissions conditional on the fields used. Grant only the operations required. Microsoft licensing is independent of consent; each registry entry links to licensing guidance. Terms of Use agreement management remains unavailable under app-only authentication.

<!-- capabilities:start -->
| Configuration type | Read | Write | Optional references and assignments | Rollback / support |
| --- | --- | --- | --- | --- |
| conditional-access-policies | Policy.Read.All | Policy.ReadWrite.ConditionalAccess | Application.Read.All; Group.Read.All; Policy.Read.All; RoleManagement.Read.Directory; User.Read.All | Managed fields only; see deployment review |
| named-locations | Policy.Read.All | Policy.ReadWrite.ConditionalAccess | None | Managed fields only; see deployment review |
| groups | Group.Read.All | Group.ReadWrite.All | Application.Read.All; Device.Read.All; Group.Read.All; User.Read.All | Managed fields only; see deployment review |
| administrative-units | AdministrativeUnit.Read.All | AdministrativeUnit.ReadWrite.All | Device.Read.All; Group.Read.All; User.Read.All | Managed fields only; see deployment review |
| authentication-strength-policies | Policy.Read.All | Policy.ReadWrite.ConditionalAccess | None | Managed fields only; see deployment review |
| token-lifetime-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | Application.Read.All; application/service-principal assignments: Application.ReadWrite.All | Managed fields only; see deployment review |
| claims-mapping-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | Application.Read.All; application/service-principal assignments: Application.ReadWrite.All | Managed fields only; see deployment review |
| directory-role-definitions | RoleManagement.Read.Directory | RoleManagement.ReadWrite.Directory | None | Managed fields only; see deployment review |
| authentication-context-class-references | Policy.Read.All | Policy.ReadWrite.ConditionalAccess | None | Managed fields only; see deployment review |
| authorization-policy | Policy.Read.All | Policy.ReadWrite.Authorization | Policy.Read.PermissionGrant | Managed fields only; see deployment review |
| identity-security-defaults | Policy.Read.All | Policy.ReadWrite.SecurityDefaults | None | Managed fields only; see deployment review |
| token-issuance-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | Application.Read.All; application/service-principal assignments: Application.ReadWrite.All | Managed fields only; see deployment review |
| home-realm-discovery-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | Application.Read.All; application/service-principal assignments: Application.ReadWrite.All | Managed fields only; see deployment review |
| activity-based-timeout-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | None | Managed fields only; see deployment review |
| admin-consent-request-policy | Policy.Read.All | Policy.ReadWrite.ConsentRequest | None | Managed fields only; see deployment review |
| app-management-policies | Policy.Read.All | Policy.ReadWrite.ApplicationConfiguration | Application.Read.All; application/service-principal assignments: Application.ReadWrite.All | Managed fields only; see deployment review |
| authentication-methods-policy | Policy.Read.AuthenticationMethod | Policy.ReadWrite.AuthenticationMethod | None | Managed fields only; see deployment review |
| cross-tenant-access-partners | Policy.Read.All | Policy.ReadWrite.CrossTenantAccess | None | Managed fields only; see deployment review |
| permission-grant-policies | Policy.Read.PermissionGrant | Policy.ReadWrite.PermissionGrant | None | Managed fields only; see deployment review |
| feature-rollout-policies | Policy.Read.All | Policy.ReadWrite.FeatureRollout | Group.Read.All | Managed fields only; see deployment review |
| group-settings | Directory.Read.All | Directory.ReadWrite.All | Directory.Read.All | Managed fields only; see deployment review |
| custom-security-attribute-sets | CustomSecAttributeDefinition.Read.All | CustomSecAttributeDefinition.ReadWrite.All | None | Created attribute sets cannot be deleted. |
| custom-security-attribute-definitions | CustomSecAttributeDefinition.Read.All | CustomSecAttributeDefinition.ReadWrite.All | None | Created definitions are deprecated, not deleted. Immutable schema changes cannot be reversed. |
| entitlement-access-package-catalogs | EntitlementManagement.Read.All | EntitlementManagement.ReadWrite.All | None | Managed fields only; see deployment review |
| authentication-flows-policy | Policy.Read.All | Policy.ReadWrite.AuthenticationFlows | None | Managed fields only; see deployment review |
| external-identity-providers | IdentityProvider.Read.All | IdentityProvider.ReadWrite.All | None | Prior write-only client secrets cannot be recovered. |
| oauth2-permission-grants | Directory.Read.All | DelegatedPermissionGrant.ReadWrite.All | Application.Read.All; User.Read.All | Managed fields only; see deployment review |
| user-flow-attributes | IdentityUserFlow.Read.All | IdentityUserFlow.ReadWrite.All | None | Managed fields only; see deployment review |
| b2x-user-flows | IdentityUserFlow.Read.All | IdentityUserFlow.ReadWrite.All | IdentityProvider.Read.All; IdentityUserFlow.Read.All | User flow creation properties cannot be updated in place. |
| entitlement-connected-organizations | EntitlementManagement.Read.All | EntitlementManagement.ReadWrite.All | None | Managed fields only; see deployment review |
| entitlement-access-packages | EntitlementManagement.Read.All | EntitlementManagement.ReadWrite.All | EntitlementManagement.Read.All | Managed fields only; see deployment review |
| entitlement-assignment-policies | EntitlementManagement.Read.All | EntitlementManagement.ReadWrite.All | Application.Read.All; EntitlementManagement.Read.All; Group.Read.All; User.Read.All | Managed fields only; see deployment review |
| access-review-definitions | AccessReview.Read.All | AccessReview.ReadWrite.All | Application.Read.All; EntitlementManagement.Read.All; Group.Read.All; RoleManagement.Read.Directory; User.Read.All | Managed fields only; see deployment review |
| lifecycle-workflows | LifecycleWorkflows.Read.All | LifecycleWorkflows.ReadWrite.All | LifecycleWorkflows.Read.All | Managed fields only; see deployment review |
| organizational-branding | Organization.Read.All, OrganizationalBranding.Read.All | OrganizationalBranding.ReadWrite.All | None | Managed fields only; see deployment review |
| pim-role-management-policies | RoleManagementPolicy.Read.Directory | RoleManagementPolicy.ReadWrite.Directory | RoleManagement.Read.Directory | Managed fields only; see deployment review |
| directory-role-assignments | RoleManagement.Read.Directory | RoleManagement.ReadWrite.Directory | AdministrativeUnit.Read.All; Application.Read.All; Group.Read.All; RoleManagement.Read.Directory; User.Read.All | Managed fields only; see deployment review |
| pim-role-eligibility | RoleEligibilitySchedule.Read.Directory | RoleEligibilitySchedule.ReadWrite.Directory | AdministrativeUnit.Read.All; Application.Read.All; Group.Read.All; RoleManagement.Read.Directory; User.Read.All | Reversal submits an asynchronous PIM request; verify the resulting schedule. |
| applications | Application.Read.All | Application.ReadWrite.All | Application.Read.All; User.Read.All | Managed fields only; see deployment review |
| service-principals | Application.Read.All | Application.ReadWrite.All | Application.Read.All; User.Read.All | Managed fields only; see deployment review |
| terms-of-use-agreements | Unsupported | Unsupported | None | Graph agreement listing does not support application permissions. Manage agreements in Entra and reference existing agreement IDs in Conditional Access. |
| cross-tenant-access-default | Policy.Read.All | Policy.ReadWrite.CrossTenantAccess | None | Managed fields only; see deployment review |
<!-- capabilities:end -->
