// Shared by setup, readiness and deployment review. Keep contract tests aligned with manifest.yaml.
export interface EntraCapability {
 id: string; name: string; endpoint: string; probe: string; apiVersion: string
 readPermissions: string[]; writePermissions: string[]; pickerDependencies: string[]; pickerPermissions: string[]
 appOnly: boolean; unsupportedReason?: string; licensing: string; licensingUrl: string; permissionUrl: string; rollbackLimits: string[]; optionalWritePermissions?: Record<string, string[]>
}
export const CAPABILITIES: EntraCapability[] = [
  {
    "id": "conditional-access-policies",
    "name": "Conditional Access Policies",
    "endpoint": "/identity/conditionalAccess/policies",
    "probe": "/identity/conditionalAccess/policies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ConditionalAccess"
    ],
    "pickerDependencies": [
      "groups",
      "usersInclude",
      "usersExclude",
      "roleDefinitions",
      "namedLocationsInclude",
      "namedLocations",
      "applications",
      "authStrengthPolicies",
      "termsOfUse"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "Group.Read.All",
      "Policy.Read.All",
      "RoleManagement.Read.Directory",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Entra ID P1; risk-based policies require P2",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "named-locations",
    "name": "Named Locations",
    "endpoint": "/identity/conditionalAccess/namedLocations",
    "probe": "/identity/conditionalAccess/namedLocations?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ConditionalAccess"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Entra ID P1; risk-based policies require P2",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "groups",
    "name": "Security Groups",
    "endpoint": "/groups",
    "probe": "/groups?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Group.Read.All"
    ],
    "writePermissions": [
      "Group.ReadWrite.All"
    ],
    "pickerDependencies": [
      "ownerPrincipals",
      "groupMembers"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "Device.Read.All",
      "Group.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "administrative-units",
    "name": "Administrative Units",
    "endpoint": "/directory/administrativeUnits",
    "probe": "/directory/administrativeUnits?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "AdministrativeUnit.Read.All"
    ],
    "writePermissions": [
      "AdministrativeUnit.ReadWrite.All"
    ],
    "pickerDependencies": [
      "administrativeUnitMembers"
    ],
    "pickerPermissions": [
      "Device.Read.All",
      "Group.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "authentication-strength-policies",
    "name": "Authentication Strengths",
    "endpoint": "/policies/authenticationStrengthPolicies",
    "probe": "/policies/authenticationStrengthPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ConditionalAccess"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Entra ID P1; risk-based policies require P2",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "token-lifetime-policies",
    "name": "Token Lifetime Policies",
    "endpoint": "/policies/tokenLifetimePolicies",
    "probe": "/policies/tokenLifetimePolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [
      "servicePrincipals"
    ],
    "pickerPermissions": [
      "Application.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [],
    "optionalWritePermissions": {
      "application/service-principal assignments": [
        "Application.ReadWrite.All"
      ]
    }
  },
  {
    "id": "claims-mapping-policies",
    "name": "Claims Mapping Policies",
    "endpoint": "/policies/claimsMappingPolicies",
    "probe": "/policies/claimsMappingPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [
      "servicePrincipals"
    ],
    "pickerPermissions": [
      "Application.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [],
    "optionalWritePermissions": {
      "application/service-principal assignments": [
        "Application.ReadWrite.All"
      ]
    }
  },
  {
    "id": "directory-role-definitions",
    "name": "Custom Role Definitions",
    "endpoint": "/roleManagement/directory/roleDefinitions",
    "probe": "/roleManagement/directory/roleDefinitions?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "RoleManagement.Read.Directory"
    ],
    "writePermissions": [
      "RoleManagement.ReadWrite.Directory"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "authentication-context-class-references",
    "name": "Authentication Contexts",
    "endpoint": "/identity/conditionalAccess/authenticationContextClassReferences",
    "probe": "/identity/conditionalAccess/authenticationContextClassReferences?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ConditionalAccess"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "authorization-policy",
    "name": "Tenant Authorization Policy",
    "endpoint": "/policies/authorizationPolicy",
    "probe": "/policies/authorizationPolicy?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.Authorization"
    ],
    "pickerDependencies": [
      "permissionGrantPolicies"
    ],
    "pickerPermissions": [
      "Policy.Read.PermissionGrant"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "identity-security-defaults",
    "name": "Security Defaults",
    "endpoint": "/policies/identitySecurityDefaultsEnforcementPolicy",
    "probe": "/policies/identitySecurityDefaultsEnforcementPolicy?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.SecurityDefaults"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "token-issuance-policies",
    "name": "Token Issuance Policies",
    "endpoint": "/policies/tokenIssuancePolicies",
    "probe": "/policies/tokenIssuancePolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [
      "applicationObjects"
    ],
    "pickerPermissions": [
      "Application.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [],
    "optionalWritePermissions": {
      "application/service-principal assignments": [
        "Application.ReadWrite.All"
      ]
    }
  },
  {
    "id": "home-realm-discovery-policies",
    "name": "Home Realm Discovery Policies",
    "endpoint": "/policies/homeRealmDiscoveryPolicies",
    "probe": "/policies/homeRealmDiscoveryPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [
      "servicePrincipals"
    ],
    "pickerPermissions": [
      "Application.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [],
    "optionalWritePermissions": {
      "application/service-principal assignments": [
        "Application.ReadWrite.All"
      ]
    }
  },
  {
    "id": "activity-based-timeout-policies",
    "name": "Activity-Based Timeout Policies",
    "endpoint": "/policies/activityBasedTimeoutPolicies",
    "probe": "/policies/activityBasedTimeoutPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "admin-consent-request-policy",
    "name": "Admin Consent Request Policy",
    "endpoint": "/policies/adminConsentRequestPolicy",
    "probe": "/policies/adminConsentRequestPolicy?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ConsentRequest"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "app-management-policies",
    "name": "App Management Policies",
    "endpoint": "/policies/appManagementPolicies",
    "probe": "/policies/appManagementPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.ApplicationConfiguration"
    ],
    "pickerDependencies": [
      "applicationOrServicePrincipal"
    ],
    "pickerPermissions": [
      "Application.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [],
    "optionalWritePermissions": {
      "application/service-principal assignments": [
        "Application.ReadWrite.All"
      ]
    }
  },
  {
    "id": "authentication-methods-policy",
    "name": "Authentication Methods",
    "endpoint": "/policies/authenticationMethodsPolicy",
    "probe": "/policies/authenticationMethodsPolicy?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.AuthenticationMethod"
    ],
    "writePermissions": [
      "Policy.ReadWrite.AuthenticationMethod"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "cross-tenant-access-partners",
    "name": "Cross-Tenant Access Partners",
    "endpoint": "/policies/crossTenantAccessPolicy/partners",
    "probe": "/policies/crossTenantAccessPolicy/partners?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.CrossTenantAccess"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "permission-grant-policies",
    "name": "Permission Grant Policies",
    "endpoint": "/policies/permissionGrantPolicies",
    "probe": "/policies/permissionGrantPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.PermissionGrant"
    ],
    "writePermissions": [
      "Policy.ReadWrite.PermissionGrant"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "feature-rollout-policies",
    "name": "Feature Rollout Policies",
    "endpoint": "/policies/featureRolloutPolicies",
    "probe": "/policies/featureRolloutPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.FeatureRollout"
    ],
    "pickerDependencies": [
      "groups"
    ],
    "pickerPermissions": [
      "Group.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "group-settings",
    "name": "Group Settings",
    "endpoint": "/groupSettings",
    "probe": "/groupSettings?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Directory.Read.All"
    ],
    "writePermissions": [
      "Directory.ReadWrite.All"
    ],
    "pickerDependencies": [
      "groupSettingTemplates"
    ],
    "pickerPermissions": [
      "Directory.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "custom-security-attribute-sets",
    "name": "Custom Security Attribute Sets",
    "endpoint": "/directory/attributeSets",
    "probe": "/directory/attributeSets?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "CustomSecAttributeDefinition.Read.All"
    ],
    "writePermissions": [
      "CustomSecAttributeDefinition.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "Created attribute sets cannot be deleted."
    ]
  },
  {
    "id": "custom-security-attribute-definitions",
    "name": "Custom Security Attribute Definitions",
    "endpoint": "/directory/customSecurityAttributeDefinitions",
    "probe": "/directory/customSecurityAttributeDefinitions?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "CustomSecAttributeDefinition.Read.All"
    ],
    "writePermissions": [
      "CustomSecAttributeDefinition.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "Created definitions are deprecated, not deleted. Immutable schema changes cannot be reversed."
    ]
  },
  {
    "id": "entitlement-access-package-catalogs",
    "name": "Access Package Catalogs",
    "endpoint": "/identityGovernance/entitlementManagement/catalogs",
    "probe": "/identityGovernance/entitlementManagement/catalogs?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "EntitlementManagement.Read.All"
    ],
    "writePermissions": [
      "EntitlementManagement.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "authentication-flows-policy",
    "name": "Authentication Flows Policy",
    "endpoint": "/policies/authenticationFlowsPolicy",
    "probe": "/policies/authenticationFlowsPolicy?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.AuthenticationFlows"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "external-identity-providers",
    "name": "External Identity Providers",
    "endpoint": "/identity/identityProviders",
    "probe": "/identity/identityProviders?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "IdentityProvider.Read.All"
    ],
    "writePermissions": [
      "IdentityProvider.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "Prior write-only client secrets cannot be recovered."
    ]
  },
  {
    "id": "oauth2-permission-grants",
    "name": "Delegated Permission Grants",
    "endpoint": "/oauth2PermissionGrants",
    "probe": "/oauth2PermissionGrants?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Directory.Read.All"
    ],
    "writePermissions": [
      "DelegatedPermissionGrant.ReadWrite.All"
    ],
    "pickerDependencies": [
      "servicePrincipals",
      "users"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "user-flow-attributes",
    "name": "User Flow Attributes",
    "endpoint": "/identity/userFlowAttributes",
    "probe": "/identity/userFlowAttributes?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "IdentityUserFlow.Read.All"
    ],
    "writePermissions": [
      "IdentityUserFlow.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "b2x-user-flows",
    "name": "Self-Service Sign-Up Flows",
    "endpoint": "/identity/b2xUserFlows",
    "probe": "/identity/b2xUserFlows?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "IdentityUserFlow.Read.All"
    ],
    "writePermissions": [
      "IdentityUserFlow.ReadWrite.All"
    ],
    "pickerDependencies": [
      "identityProviders",
      "userFlowAttributes"
    ],
    "pickerPermissions": [
      "IdentityProvider.Read.All",
      "IdentityUserFlow.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "User flow creation properties cannot be updated in place."
    ]
  },
  {
    "id": "entitlement-connected-organizations",
    "name": "Connected Organizations",
    "endpoint": "/identityGovernance/entitlementManagement/connectedOrganizations",
    "probe": "/identityGovernance/entitlementManagement/connectedOrganizations?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "EntitlementManagement.Read.All"
    ],
    "writePermissions": [
      "EntitlementManagement.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "entitlement-access-packages",
    "name": "Access Packages",
    "endpoint": "/identityGovernance/entitlementManagement/accessPackages",
    "probe": "/identityGovernance/entitlementManagement/accessPackages?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "EntitlementManagement.Read.All"
    ],
    "writePermissions": [
      "EntitlementManagement.ReadWrite.All"
    ],
    "pickerDependencies": [
      "accessPackageCatalogs"
    ],
    "pickerPermissions": [
      "EntitlementManagement.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "entitlement-assignment-policies",
    "name": "Assignment Policies",
    "endpoint": "/identityGovernance/entitlementManagement/assignmentPolicies",
    "probe": "/identityGovernance/entitlementManagement/assignmentPolicies?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "EntitlementManagement.Read.All"
    ],
    "writePermissions": [
      "EntitlementManagement.ReadWrite.All"
    ],
    "pickerDependencies": [
      "accessPackages",
      "users",
      "groups",
      "servicePrincipals",
      "connectedOrganizations"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "EntitlementManagement.Read.All",
      "Group.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "access-review-definitions",
    "name": "Access Review Definitions",
    "endpoint": "/identityGovernance/accessReviews/definitions",
    "probe": "/identityGovernance/accessReviews/definitions?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "AccessReview.Read.All"
    ],
    "writePermissions": [
      "AccessReview.ReadWrite.All"
    ],
    "pickerDependencies": [
      "groups",
      "roleDefinitions",
      "accessPackages",
      "servicePrincipals",
      "users"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "EntitlementManagement.Read.All",
      "Group.Read.All",
      "RoleManagement.Read.Directory",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "lifecycle-workflows",
    "name": "Lifecycle Workflows",
    "endpoint": "/identityGovernance/lifecycleWorkflows/workflows",
    "probe": "/identityGovernance/lifecycleWorkflows/workflows?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "LifecycleWorkflows.Read.All"
    ],
    "writePermissions": [
      "LifecycleWorkflows.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [
      "LifecycleWorkflows.Read.All"
    ],
    "appOnly": true,
    "licensing": "Entra ID Governance",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "organizational-branding",
    "name": "Organizational Branding",
    "endpoint": "/organization",
    "probe": "/organization?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Organization.Read.All",
      "OrganizationalBranding.Read.All"
    ],
    "writePermissions": [
      "OrganizationalBranding.ReadWrite.All"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "pim-role-management-policies",
    "name": "PIM Role Policies",
    "endpoint": "/policies/roleManagementPolicies",
    "probe": "/policies/roleManagementPolicies?$top=1&$select=id&$filter=scopeId%20eq%20'/'%20and%20scopeType%20eq%20'Directory'",
    "apiVersion": "v1.0",
    "readPermissions": [
      "RoleManagementPolicy.Read.Directory"
    ],
    "writePermissions": [
      "RoleManagementPolicy.ReadWrite.Directory"
    ],
    "pickerDependencies": [
      "roleDefinitions"
    ],
    "pickerPermissions": [
      "RoleManagement.Read.Directory"
    ],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "directory-role-assignments",
    "name": "Directory Role Assignments",
    "endpoint": "/roleManagement/directory/roleAssignments",
    "probe": "/roleManagement/directory/roleAssignments?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "RoleManagement.Read.Directory"
    ],
    "writePermissions": [
      "RoleManagement.ReadWrite.Directory"
    ],
    "pickerDependencies": [
      "roleDefinitions",
      "directoryPrincipals",
      "directoryScope"
    ],
    "pickerPermissions": [
      "AdministrativeUnit.Read.All",
      "Application.Read.All",
      "Group.Read.All",
      "RoleManagement.Read.Directory",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "pim-role-eligibility",
    "name": "PIM Role Eligibility",
    "endpoint": "/roleManagement/directory/roleEligibilitySchedules",
    "probe": "/roleManagement/directory/roleEligibilitySchedules?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "RoleEligibilitySchedule.Read.Directory"
    ],
    "writePermissions": [
      "RoleEligibilitySchedule.ReadWrite.Directory"
    ],
    "pickerDependencies": [
      "directoryPrincipals",
      "roleDefinitions",
      "directoryScope"
    ],
    "pickerPermissions": [
      "AdministrativeUnit.Read.All",
      "Application.Read.All",
      "Group.Read.All",
      "RoleManagement.Read.Directory",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify Entra ID Governance / P2 entitlement for the selected scenario",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "Reversal submits an asynchronous PIM request; verify the resulting schedule."
    ]
  },
  {
    "id": "applications",
    "name": "App Registrations",
    "endpoint": "/applications",
    "probe": "/applications?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Application.Read.All"
    ],
    "writePermissions": [
      "Application.ReadWrite.All"
    ],
    "pickerDependencies": [
      "ownerPrincipals"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "service-principals",
    "name": "Service Principals",
    "endpoint": "/servicePrincipals",
    "probe": "/servicePrincipals?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Application.Read.All"
    ],
    "writePermissions": [
      "Application.ReadWrite.All"
    ],
    "pickerDependencies": [
      "ownerPrincipals"
    ],
    "pickerPermissions": [
      "Application.Read.All",
      "User.Read.All"
    ],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  },
  {
    "id": "terms-of-use-agreements",
    "name": "Terms of Use Agreements",
    "endpoint": "/identityGovernance/termsOfUse/agreements",
    "probe": "/identityGovernance/termsOfUse/agreements?$top=1&$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [],
    "writePermissions": [],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": false,
    "unsupportedReason": "Graph agreement listing does not support application permissions. Manage agreements in Entra and reference existing agreement IDs in Conditional Access.",
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": [
      "Unsupported with app-only authentication; PDF contents cannot be restored."
    ]
  },
  {
    "id": "cross-tenant-access-default",
    "name": "Cross-Tenant Access Default",
    "endpoint": "/policies/crossTenantAccessPolicy/default",
    "probe": "/policies/crossTenantAccessPolicy/default?$select=id",
    "apiVersion": "v1.0",
    "readPermissions": [
      "Policy.Read.All"
    ],
    "writePermissions": [
      "Policy.ReadWrite.CrossTenantAccess"
    ],
    "pickerDependencies": [],
    "pickerPermissions": [],
    "appOnly": true,
    "licensing": "Verify feature entitlement in the target tenant",
    "licensingUrl": "https://learn.microsoft.com/en-us/entra/fundamentals/licensing",
    "permissionUrl": "https://learn.microsoft.com/en-us/graph/permissions-reference",
    "rollbackLimits": []
  }
]
export const capabilityFor = (id: string) => CAPABILITIES.find(c => c.id === id)
