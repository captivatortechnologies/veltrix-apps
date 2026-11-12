# Microsoft Entra feature coverage audit

Reviewed on 2026-11-12 against the app's 42 declared configuration types. **This app does not currently provide full Microsoft Entra functionality.** A configuration type represents a bounded set of managed fields; it does not establish complete coverage of its Microsoft feature or product.

The scope here is the entire Microsoft Entra family, following Microsoft's [product catalog](https://learn.microsoft.com/en-us/entra/fundamentals/what-is-entra), [Entra ID documentation](https://learn.microsoft.com/en-us/entra/identity/), and [admin center feature areas](https://learn.microsoft.com/en-us/entra/fundamentals/entra-admin-center). Coverage below is an assessment of the repository's handlers and canvas fields, not a live certification of tenant behavior.

## Coverage of Entra ID administration

| Feature area | Existing coverage | Missing functionality | Status |
| --- | --- | --- | --- |
| Users and account lifecycle | Referenced by pickers, group membership, roles and lifecycle workflow tasks | User creation/profile management, managers, account operations, deletion/restoration, guest invitations and user extensions | Missing direct administration |
| Licensing | No dedicated configuration type or operation | License inventory, user/group assignment, service-plan selection, assignment diagnostics | Missing |
| Domains and federation | Home-realm discovery policies | Domain inventory/verification, domain federation settings, primary-domain operations and DNS-proof workflow | Partial |
| Groups | Assigned security groups, descriptions, owners and members; group settings | Dynamic membership/rules, Microsoft 365 groups, role-assignable group lifecycle, licensing and broader group properties | Partial; unsupported group kinds are protected |
| Administrative units | Scalar properties and members | Restricted-management scenarios and complete scoped-role lifecycle | Partial |
| Custom security attributes | Sets and typed definitions | User/service-principal assignments, allowed-value lifecycle and complete schema lifecycle | Partial; irreversible changes have limits |
| Devices | Used as references and group/AU members | Device inventory administration, enable/disable, ownership/registered-user lifecycle and device settings | Missing direct administration |
| Directory roles | Custom role definitions and role assignments | Complete role discovery/administration, all scope variants and scheduled assignment workflows | Partial |
| Privileged Identity Management | Directory role eligibility and activation-policy configuration | Assignment schedules, activation requests, approvals, audit/alerts, PIM for Groups, Azure-resource PIM | Partial |
| Authentication methods | Per-method enablement state and custom strengths | Per-method targeting and advanced configuration, user method lifecycle, registration campaigns, registration reporting and complete certificate-authentication settings | Partial |
| Password reset and protection | Security defaults and selected authentication policy state | Complete SSPR settings, password protection configuration, reset operations and on-premises agent integration | Partial foundation only |
| Conditional Access | User/group/role and cloud-app targeting, named locations, grant controls, strengths and contexts | Risk, device/platform/client conditions, device filters, session controls, workload/agent targeting, broader external-user targeting and complete policy schema | Partial |
| Terms of Use | Existing agreement IDs can be referenced in Conditional Access | Agreement management requires a supported delegated-token lifecycle; current app-only handlers are gated | Blocked under current authentication contract |
| Application registrations | Selected identity, redirect, app-role, permission-request and owner fields | Full application schema, exposed API scopes, optional claims, credential lifecycle, federated identity credentials and application-template lifecycle | Partial |
| Enterprise applications | Selected service-principal fields and owners | App-role assignments, complete SAML/SSO configuration, certificates, gallery lifecycle and broader service-principal properties | Partial |
| Consent and authorization | Delegated permission grants, permission-grant policies, admin-consent-request settings and authorization policy | Application permission/app-role grant lifecycle, consent-request review/approval operations and comprehensive consent diagnostics | Partial |
| Token and app policies | Lifetime, issuance, claims mapping, home-realm discovery, idle timeout and app-management policies with selected assignments | Complete application and tenant settings outside these policy schemas, credential operations and operational diagnostics | Partial |
| External collaboration | Default and partner cross-tenant access settings, external providers, authentication-flows policy and b2x user flows | Complete invitations/redemption, cross-tenant synchronization, external-tenant CIAM flows, custom authentication extensions and legacy custom policy lifecycle | Partial |
| Multitenant organizations | Partner cross-tenant access settings | Organization membership, join requests, templates and provisioning/synchronization lifecycle | Partial foundation only |
| Tenant governance | Selected tenant policies and branding scalars | Tenant creation/discovery relationships, tenant restrictions/governance workflows, broader organization settings, branding images and CSS | Partial |
| Monitoring, audit and health | App connection checks, deployment status, drift and managed-field verification | Sign-in/audit/provisioning logs, diagnostic settings, recommendations, identity secure score, service-health views and report workflows | Missing Microsoft-service reporting |
| Application provisioning | No dedicated provisioning integration | Synchronization schemas, jobs, secrets, mappings, schedules, on-demand provisioning and provisioning agent operations | Missing |
| Hybrid identity | No dedicated hybrid integration | Entra Connect/Cloud Sync configuration, agents, synchronization operations and on-premises prerequisites | Requires additional integration |
| Application Proxy | No dedicated proxy integration | Connector groups, application publishing, connector lifecycle and private-access integration | Missing |
| Deleted objects and recovery | App-owned rollback for supported managed fields | Directory deleted-item inventory, restoration and permanent deletion workflows | Missing |

The implemented fields are inspectable in each `config-types/<id>/canvas.yaml`. For example, the authentication-methods canvas contains only `method` and `state`; the groups canvas contains only `name`, `description`, `mailNickname`, `owners`, and `members`. Those schemas cannot represent all functionality of the corresponding Entra features.

## Coverage of the wider Entra family

| Product or feature area | Current app coverage | Work required |
| --- | --- | --- |
| Entra ID Governance: entitlement management | Catalogs, packages, assignment policies and connected organizations | Resource onboarding/roles/scopes, assignment requests and grants, approvals, expiration/review operations and complete settings |
| Entra ID Governance: access reviews | Schedule definitions, scopes, reviewers and settings | Instances, decisions, recommendations, reviewer actions and applying results |
| Entra ID Governance: lifecycle workflows | Workflow definitions, execution conditions and tasks | Execution operations/history, workflow versions, custom task extensions and complete lifecycle administration |
| Entra ID Protection | No dedicated integration | Risky users, risk detections, risky workload identities, investigation and remediation operations |
| Entra External ID | Some workforce B2B/self-service configuration | External-tenant customer identity administration and the remaining CIAM surface |
| Entra Workload ID | Application/service-principal configuration subset | Federated credentials, workload risk, workload-specific policies and full identity lifecycle |
| Entra Agent ID | No dedicated integration | Agent identities/blueprints, lifecycle, assignments and governance; separately assess preview APIs |
| Entra Verified ID | No dedicated integration | Its service-specific administration and issuance/presentation workflows, audience, callbacks and credential lifecycle |
| Entra Domain Services | No dedicated integration | Azure Resource Manager integration, managed-domain resources, networking, replication, backups and management operations |
| Entra Internet Access | No dedicated integration | Global Secure Access policies/profiles, traffic forwarding, filtering, client/remote-network administration and monitoring |
| Entra Private Access | No dedicated integration | Private application segments, connectors/groups, access profiles, client/remote-network administration and monitoring |

A single Graph v1.0 client cannot establish coverage of services that require other API audiences, Azure Resource Manager, delegated identity, preview interfaces, local agents or callbacks. Microsoft's [Graph versioning guidance](https://learn.microsoft.com/en-us/graph/api/overview?view=graph-rest-1.0) also distinguishes stable v1.0 APIs from preview APIs; enabling a generic API passthrough would not provide a tested feature implementation.

## Implementation order

1. **Directory administration:** implement users, licensing, domains and device administration with separate reversible configuration handlers and explicit one-off lifecycle operations. Keep passwords and credential material in supported vault flows.
2. **Existing partial features:** extend Conditional Access conditions/session controls, authentication method targeting, dynamic groups, app-role assignments, application scopes and federated credentials. Add migration tests for existing canvases.
3. **Governance and risk:** complete entitlement resource/assignment workflows, review decisions, PIM schedules/approvals, lifecycle execution/extensions, and identity-risk reporting/remediation.
4. **Operational integrations:** add reporting and provisioning, then platform-supported delegated credentials, callbacks and hybrid agents where required.
5. **Additional products:** add explicit service adapters for Verified ID, Domain Services and Global Secure Access. Keep their audiences, credentials, permissions and licensing distinct from the Graph app-only connection.

## Definition of full coverage

For every feature in the chosen product scope, maintain an operation-level record of supported fields, read/create/update/delete and one-off actions, API version, cloud availability, authentication model, permission dependencies, licensing and irreversible effects. Link each supported operation to its handler, UI and validation tests. Record delegated-only, preview-only and service-specific constraints explicitly.

Full coverage requires closing the missing and partial areas above, passing regression tests and licensed sandbox checks, and validating the relevant product integrations. Until then, releases must describe this as selected Entra configuration management, not complete Entra administration. The 42-type capability registry remains a registry of implemented configuration types; it is not a complete Entra product inventory.
