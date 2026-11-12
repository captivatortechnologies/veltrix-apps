# Microsoft Entra feature coverage

Reviewed on 2026-11-12 for version 0.10.0. The app implements **64 configuration types, 40 administrative operations and 31 read-only reports**. This is substantial Graph v1.0 administration, but it does not cover every Microsoft Entra feature. Handler tests use fake Graph responses; live tenant acceptance remains required.

## Implemented administration

| Area | Implemented functionality | Remaining scope |
| --- | --- | --- |
| Users and devices | Existing profile/account state updates, inventory, guest invitations, manager relationships, session revocation, deletion/recovery | Account creation with vault-backed bootstrap credentials, user extensions, device owners/users and complete device settings |
| Licensing | SKU/service-plan inventory, direct user/group assignments and rollback, inherited-license preservation, assignment state report | Delegated licenseDetails diagnostics and complete member propagation monitoring |
| Domains | Inventory, DNS proof, add/verify, guarded unverified-domain removal, federation settings | Primary-domain changes, force deletion and automated DNS-provider integration |
| Groups | Existing assigned security-group management, separate dynamic/security, Microsoft 365 and role-assignable group configuration, explicit member/owner actions | Full Microsoft 365 workload behavior and unrestricted type conversion; group-kind conversion is intentionally rejected |
| Directory roles and PIM | Custom roles, assignments, directory eligibility/policy configuration, administrative directory/group schedule requests and reports | Delegated activation/approval, alerts and Azure-resource PIM |
| Authentication | Method state, explicit targeting/method settings, strengths, registration campaigns | User method lifecycle, credential recovery, full certificate trust/SSPR/password protection and agents |
| Conditional Access | Existing targets/locations/grants/strengths plus risk, device/client/platform/workload/external-user conditions and session controls | Complete evolving schema, agent identity policies and licensed tenant acceptance |
| Applications | Registrations/SPs, owners, API settings/optional claims, federation credentials, SAML/SSO settings, application-role assignments/revocation | Full gallery/template lifecycle, vault-backed credential rotation and full signing certificate administration |
| Custom security attributes | Sets, definitions, user/SP assignments, allowed values | Complete schema lifecycle; created allowed values can only be deactivated on rollback |
| Entitlement management | Catalogs/packages/policies/connected organizations, resource onboarding requests, package resource roles, assignment requests and reports | Delegated approvals, every assignment/expiration scenario and full settings |
| Reviews and lifecycle workflows | Review definitions/instances/decision reports, apply/stop/reset actions; lifecycle definitions/tasks, custom extensions, execution and run reports | Delegated reviewer decisions, complete workflow version/history administration |
| Identity Protection | Risky users/detections, dismiss/confirm-compromised actions | Workload risk, all investigation/remediation workflows and delegated recovery |
| Provisioning and hybrid | Job templates/create/start/pause/restart, schema/mappings PUT, on-demand provisioning, logs; Graph hybrid configuration/features | Provisioning secrets, schedules, connectors/agents and local installation/health |
| External identity and multitenant organizations | Existing B2B/cross-tenant policies/providers/flows, inbound synchronization, organization settings/create/join/member actions | Full external-tenant CIAM, custom authentication extensions, templates and all cross-tenant jobs |
| Monitoring and recovery | Bounded sign-in/audit/provisioning/risk/governance views, deleted objects, restore/permanent delete; app health/drift | Complete exports, diagnostics streaming, recommendations, secure score and Microsoft service health |
| Other tenant configuration | Existing policies, administrative units, consent configuration and branding scalars | Restricted administrative units/scoped role lifecycle, consent review operations, branding assets and full tenant governance |

The field allowlists live in `lib/resourceDefinitions.ts` and the existing canvases. `lib/operationDefinitions.ts` and `lib/reportDefinitions.ts` define the exact executable action/report catalogs. Generated permission profiles in README and Setup are configuration profiles, not an assertion of complete product coverage.

## Authentication and service boundaries

- Terms of Use agreement enumeration and access-review reviewer decision updates require delegated user authentication. These are not exposed as app-only writes. [Agreement listing](https://learn.microsoft.com/en-us/graph/api/termsofusecontainer-list-agreements?view=graph-rest-1.0), [review decision update](https://learn.microsoft.com/en-us/graph/api/accessreviewinstancedecisionitem-update?view=graph-rest-1.0).
- The user license report reads `assignedLicenses`, `licenseAssignmentStates` and `assignedPlans` through the user resource. It does not call [licenseDetails](https://learn.microsoft.com/en-us/graph/api/user-list-licensedetails?view=graph-rest-1.0), which does not support application permissions.
- Verified ID needs its own service audience, issuance/presentation callbacks and credential lifecycle. Domain Services and Azure-resource PIM need Azure Resource Manager integration and Azure authorization.
- Internet/Private Access, Application Proxy and hybrid connectors need their documented service/agent contracts; this release does not enable generic beta endpoint passthrough.
- Agent ID and complete External ID customer identity support require dedicated feature implementations and preview/version decisions where relevant.

See Microsoft's [Entra product inventory](https://learn.microsoft.com/en-us/entra/fundamentals/what-is-entra) for the wider product scope. National-cloud availability and feature licenses must be checked for each intended endpoint; selecting a cloud does not establish that every feature is available there.

## Remaining implementation plan

1. Add platform-supported delegated connections for reviewer decisions, PIM activation/approval, Terms of Use and delegated diagnostics. This needs user consent, token refresh/revocation and tenant/user binding.
2. Add vault output/rotation contracts before account bootstrap, provisioning secrets or application credential creation. Never return generated secrets in operation results or canvas artifacts.
3. Implement separate Verified ID, Azure Resource Manager and network-access service adapters with explicit audiences, permissions and callbacks/agents.
4. Expand each partial area above with endpoint-specific operations and migration tests, then run licensed sandbox acceptance across the intended clouds.

Full coverage requires closing every remaining row and integration dependency. Local regression counts alone do not certify Microsoft Entra product parity.
