export interface ResourceDefinition {
  id: string
  name: string
  collection: string
  fields: string[]
  required?: string[]
  identity: string[]
  parent?: 'guid' | 'domain' | 'segment'
  query?: string
  groupKind?: 'dynamic' | 'm365' | 'role'
  rollbackCreate?: 'deactivate'
  singleton?: boolean
  suffix?: string
  create?: boolean
  update?: 'PATCH' | 'PUT' | false
  publicType?: string
  immutable?: string[]
  protectSynced?: boolean
  readPermissions: string[]
  writePermissions: string[]
  documentation: string
  sample: Record<string, unknown>
}

/** Explicit Graph resource schemas; arbitrary paths and unrecognized writable keys are rejected. */
export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    id: 'directory-user-profiles', name: 'User Profiles', collection: '/users', identity: ['id'],
    fields: ['displayName','givenName','surname','jobTitle','department','companyName','officeLocation','businessPhones','mobilePhone','streetAddress','city','state','postalCode','country','usageLocation','employeeId','employeeType','employeeHireDate','preferredLanguage','accountEnabled','otherMails'],
    protectSynced: true, update: 'PATCH', readPermissions: ['User.Read.All'], writePermissions: ['User.ReadWrite.All','User.EnableDisableAccount.All'],
    documentation: 'https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0', sample: { displayName: 'Pilot User', department: 'Security' },
  },
  {
    id: 'directory-device-profiles', name: 'Device Profiles', collection: '/devices', identity: ['id'],
    fields: ['displayName','accountEnabled','extensionAttributes'], protectSynced: true, update: 'PATCH',
    readPermissions: ['Device.Read.All'], writePermissions: ['Device.ReadWrite.All'],
    documentation: 'https://learn.microsoft.com/en-us/graph/api/device-update?view=graph-rest-1.0', sample: { displayName: 'Pilot Device', accountEnabled: true },
  },
  {
    id: 'domain-federation-configurations', name: 'Domain Federation', collection: '/domains/{parent}/federationConfiguration', parent: 'domain', identity: ['issuerUri'],
    fields: ['displayName','issuerUri','activeSignInUri','passiveSignInUri','metadataExchangeUri','signOutUri','preferredAuthenticationProtocol','signingCertificate','nextSigningCertificate','promptLoginBehavior','federatedIdpMfaBehavior','isSignedAuthenticationRequestRequired'],
    required: ['issuerUri','passiveSignInUri','preferredAuthenticationProtocol','signingCertificate'], create: true, update: 'PATCH',
    readPermissions: ['Domain.Read.All'], writePermissions: ['Domain.ReadWrite.All'], documentation: 'https://learn.microsoft.com/en-us/graph/api/domain-post-federationconfiguration?view=graph-rest-1.0',
    sample: { issuerUri:'https://idp.example.test', passiveSignInUri:'https://idp.example.test/signin', preferredAuthenticationProtocol:'saml', signingCertificate:'PUBLIC-CERTIFICATE-BASE64' },
  },
  {
    id:'application-federated-credentials', name:'Federated Application Credentials', collection:'/applications/{parent}/federatedIdentityCredentials',parent:'guid',identity:['name'],
    fields:['name','issuer','subject','audiences','description'],required:['name','issuer','subject','audiences'],immutable:['name'],create:true,update:'PATCH',
    readPermissions:['Application.Read.All'],writePermissions:['Application.ReadWrite.All'], documentation:'https://learn.microsoft.com/en-us/graph/api/federatedidentitycredential-post?view=graph-rest-1.0',
    sample:{name:'github-main',issuer:'https://token.actions.githubusercontent.com',subject:'repo:example/project:ref:refs/heads/main',audiences:['api://AzureADTokenExchange']},
  },
  {
    id:'service-principal-app-role-assignments',name:'Enterprise Application Role Assignments',collection:'/servicePrincipals/{parent}/appRoleAssignedTo',parent:'guid',identity:['principalId','resourceId','appRoleId'],
    fields:['principalId','resourceId','appRoleId'],required:['principalId','resourceId','appRoleId'],create:true,update:false,
    readPermissions:['Application.Read.All'],writePermissions:['AppRoleAssignment.ReadWrite.All','Application.Read.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0',
    sample:{principalId:'11111111-1111-1111-1111-111111111111',resourceId:'22222222-2222-2222-2222-222222222222',appRoleId:'33333333-3333-3333-3333-333333333333'},
  },
  ...(['users','servicePrincipals'] as const).map(collection => ({
    id:collection==='users'?'user-custom-security-attributes':'service-principal-custom-security-attributes',name:collection==='users'?'User Custom Security Attributes':'Workload Custom Security Attributes',collection:`/${collection}`,identity:['id'],fields:['customSecurityAttributes'],required:['customSecurityAttributes'],update:'PATCH' as const,
    readPermissions:['CustomSecAttributeAssignment.Read.All'],writePermissions:['CustomSecAttributeAssignment.ReadWrite.All'],documentation:`https://learn.microsoft.com/en-us/graph/api/${collection==='users'?'user':'serviceprincipal'}-update?view=graph-rest-1.0`,
    sample:{customSecurityAttributes:{Security:{'@odata.type':'#Microsoft.DirectoryServices.CustomSecurityAttributeValue',Classification:'Internal'}}},
  })),
  {
    id:'lifecycle-custom-task-extensions',name:'Lifecycle Custom Task Extensions',collection:'/identityGovernance/lifecycleWorkflows/customTaskExtensions',identity:['displayName'],
    fields:['displayName','description','clientConfiguration','endpointConfiguration','authenticationConfiguration','callbackConfiguration'],required:['displayName','endpointConfiguration','authenticationConfiguration'],create:true,update:'PATCH',
    publicType:'#microsoft.graph.identityGovernance.customTaskExtension',readPermissions:['LifecycleWorkflows.Read.All'],writePermissions:['LifecycleWorkflows.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/identitygovernance-lifecycleworkflowscontainer-post-customtaskextensions?view=graph-rest-1.0',
    sample:{displayName:'Lifecycle extension',endpointConfiguration:{'@odata.type':'#microsoft.graph.logicAppTriggerEndpointConfiguration',subscriptionId:'11111111-1111-1111-1111-111111111111',resourceGroupName:'identity',logicAppWorkflowName:'Onboarding'},authenticationConfiguration:{'@odata.type':'#microsoft.graph.azureAdTokenAuthentication',resourceId:'https://management.azure.com'}},
  },
  {
    id:'provisioning-job-schemas',name:'Provisioning Job Schemas',collection:'/servicePrincipals/{parent}/synchronization/jobs',parent:'guid',identity:['id'],suffix:'/schema',
    fields:['directories','synchronizationRules','version'],required:['directories','synchronizationRules'],update:'PUT',readPermissions:['Synchronization.Read.All'],writePermissions:['Synchronization.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/synchronization-synchronizationschema-update?view=graph-rest-1.0',
    sample:{directories:[],synchronizationRules:[]},
  },
  {
    id:'application-api-settings',name:'Application API and Token Settings',collection:'/applications',identity:['id'],
    fields:['api','optionalClaims','web','spa','publicClient','info','isFallbackPublicClient','serviceManagementReference'],update:'PATCH',readPermissions:['Application.Read.All'],writePermissions:['Application.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0',
    sample:{optionalClaims:{idToken:[{name:'email',essential:false}]},api:{requestedAccessTokenVersion:2}},
  },
  {
    id:'enterprise-application-sso',name:'Enterprise Application SSO Settings',collection:'/servicePrincipals',identity:['id'],
    fields:['samlSingleSignOnSettings','replyUrls','preferredSingleSignOnMode','preferredTokenSigningKeyThumbprint','loginUrl','logoutUrl','appRoleAssignmentRequired'],update:'PATCH',readPermissions:['Application.Read.All'],writePermissions:['Application.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/serviceprincipal-update?view=graph-rest-1.0',
    sample:{preferredSingleSignOnMode:'saml',samlSingleSignOnSettings:{relayState:'https://app.example.test'}},
  },
  {
    id:'authentication-registration-policy',name:'Authentication Registration Policy',collection:'/policies/authenticationMethodsPolicy',singleton:true,identity:[],
    fields:['registrationEnforcement','policyMigrationState'],update:'PATCH',readPermissions:['Policy.Read.AuthenticationMethod'],writePermissions:['Policy.ReadWrite.AuthenticationMethod'],documentation:'https://learn.microsoft.com/en-us/graph/api/authenticationmethodspolicy-update?view=graph-rest-1.0',
    sample:{registrationEnforcement:{authenticationMethodsRegistrationCampaign:{state:'disabled',snoozeDurationInDays:1,enforceRegistrationAfterAllowedSnoozes:false,includeTargets:[],excludeTargets:[]}}},
  },
  {
    id:'on-premises-synchronization',name:'Hybrid Synchronization Settings',collection:'/directory/onPremisesSynchronization',identity:['id'],
    fields:['configuration','features'],update:'PATCH',readPermissions:['OnPremDirectorySynchronization.Read.All'],writePermissions:['OnPremDirectorySynchronization.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/onpremisesdirectorysynchronization-update?view=graph-rest-1.0',
    sample:{features:{passwordSyncEnabled:true}},
  },
  {
    id:'cross-tenant-identity-synchronization',name:'Cross-Tenant Identity Synchronization',collection:'/policies/crossTenantAccessPolicy/partners/{parent}/identitySynchronization',parent:'guid',singleton:true,identity:[],
    fields:['userSyncInbound'],required:['userSyncInbound'],update:'PATCH',readPermissions:['Policy.Read.All'],writePermissions:['Policy.ReadWrite.CrossTenantAccess'],documentation:'https://learn.microsoft.com/en-us/graph/api/crosstenantidentitysyncpolicypartner-update?view=graph-rest-1.0',
    sample:{userSyncInbound:{isSyncAllowed:false}},
  },
  ...(['dynamic','m365','role'] as const).map(kind=>({
    id:kind==='dynamic'?'dynamic-security-groups':kind==='m365'?'microsoft365-groups':'role-assignable-groups',
    name:kind==='dynamic'?'Dynamic Security Groups':kind==='m365'?'Microsoft 365 Groups':'Role-Assignable Groups',
    collection:'/groups',identity:['displayName'],groupKind:kind,
    fields:['displayName','description','mailNickname','mailEnabled','securityEnabled','groupTypes','membershipRule','membershipRuleProcessingState','visibility',...(kind==='role'?['isAssignableToRole']:[])],
    required:['displayName','mailNickname','mailEnabled','securityEnabled','groupTypes',...(kind==='dynamic'?['membershipRule','membershipRuleProcessingState']:[]),...(kind==='role'?['isAssignableToRole']:[])],
    immutable:['mailEnabled','securityEnabled','groupTypes','isAssignableToRole'],create:true,update:'PATCH' as const,
    readPermissions:['Group.Read.All'],writePermissions:['Group.ReadWrite.All',...(kind==='role'?['RoleManagement.ReadWrite.Directory']:[])],
    documentation:'https://learn.microsoft.com/en-us/graph/api/group-post-groups?view=graph-rest-1.0',
    sample:{displayName:'Pilot '+kind,mailNickname:'pilot-'+kind,mailEnabled:kind==='m365',securityEnabled:kind!=='m365',groupTypes:kind==='dynamic'?['DynamicMembership']:kind==='m365'?['Unified']:[],...(kind==='dynamic'?{membershipRule:'user.department -eq "Security"',membershipRuleProcessingState:'On'}:{}),...(kind==='role'?{isAssignableToRole:true,visibility:'Private'}:{})},
  })),
  {
    id:'custom-security-attribute-allowed-values',name:'Custom Attribute Allowed Values',collection:'/directory/customSecurityAttributeDefinitions/{parent}/allowedValues',parent:'segment',identity:['id'],
    fields:['id','isActive'],required:['id','isActive'],immutable:['id'],create:true,update:'PATCH',rollbackCreate:'deactivate',readPermissions:['CustomSecAttributeDefinition.Read.All'],writePermissions:['CustomSecAttributeDefinition.ReadWrite.All'],
    documentation:'https://learn.microsoft.com/en-us/graph/api/customsecurityattributedefinition-post-allowedvalues?view=graph-rest-1.0',sample:{id:'Internal',isActive:true},
  },
  {
    id:'multitenant-organization-settings',name:'Multitenant Organization Settings',collection:'/tenantRelationships/multiTenantOrganization',singleton:true,identity:[],fields:['displayName','description'],update:'PATCH',
    readPermissions:['MultiTenantOrganization.Read.All'],writePermissions:['MultiTenantOrganization.ReadWrite.All'],documentation:'https://learn.microsoft.com/en-us/graph/api/multitenantorganization-update?view=graph-rest-1.0',sample:{displayName:'Organization',description:'Partner collaboration'},
  },
  {
    id:'entitlement-resource-role-scopes',name:'Access Package Resource Roles',collection:'/identityGovernance/entitlementManagement/accessPackages/{parent}/resourceRoleScopes',parent:'guid',identity:['role','scope'],query:'?$expand=role,scope',
    fields:['role','scope'],required:['role','scope'],create:true,update:false,readPermissions:['EntitlementManagement.Read.All'],writePermissions:['EntitlementManagement.ReadWrite.All'],
    documentation:'https://learn.microsoft.com/en-us/graph/api/accesspackage-post-resourcerolescopes?view=graph-rest-1.0',sample:{role:{id:'11111111-1111-1111-1111-111111111111'},scope:{id:'22222222-2222-2222-2222-222222222222'}},
  },

]

export const resourceDefinition = (id:string): ResourceDefinition => {
  const definition=RESOURCE_DEFINITIONS.find(d=>d.id===id)
  if(!definition)throw new Error(`Unknown Entra resource definition: ${id}`)
  return definition
}
