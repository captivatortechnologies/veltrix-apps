// =============================================================================
// GravityZone resource API — thin, typed wrappers over GravityZoneClient for
// every method this app calls. Mirrors lib/sophosApi.ts in the sibling Sophos
// Central app: one central file of list/get/create/update/delete functions,
// so every config type's deploy/rollback/driftDetect/healthCheck shares the
// exact same request-building and response handling.
//
// Every method below cites the exact Bitdefender GravityZone Public API
// support-doc page for that method (https://www.bitdefender.com/business/
// support/en/77209-<docId>-<methodname>.html) — read directly from the
// documented method name, parameters and required/optional flags. Params are
// PRECISELY as documented; response envelopes for list methods and the exact
// id key returned by create methods were not independently observed against
// a live tenant during this app's research and are read defensively — see
// lib/gravityZoneCommon.ts's readId/unwrapListItems and README.md's "Known
// limitations".
// =============================================================================

import type { GravityZoneClient } from './gravityZone'
import { readId, unwrapListItems } from './gravityZoneCommon'

// =============================================================================
// General
// https://www.bitdefender.com/business/support/en/77209-140282-getapikeydetails.html
// =============================================================================

export interface GzApiKeyDetails {
  userId?: string
  email?: string
  role?: number
  companyId?: string
  enterpriseId?: string
  rights?: Record<string, unknown>
  [key: string]: unknown
}

/** general.getApiKeyDetails — takes no parameters; identifies the account that owns the calling API key. */
export async function getApiKeyDetails(client: GravityZoneClient): Promise<GzApiKeyDetails> {
  return client.call<GzApiKeyDetails>('general', 'getApiKeyDetails', {})
}

// =============================================================================
// Accounts — Control Center user accounts
// https://www.bitdefender.com/business/support/en/77209-125282-getaccountslist.html
// https://www.bitdefender.com/business/support/en/77209-1081603-getaccountdetails.html
// https://www.bitdefender.com/business/support/en/77209-125284-createaccount.html
// https://www.bitdefender.com/business/support/en/77209-125285-updateaccount.html
// https://www.bitdefender.com/business/support/en/77209-125283-deleteaccount.html
// =============================================================================

/** Documented account roles (updateAccount): role 4 is not documented in the current API surface. */
export const GZ_ACCOUNT_ROLES = [
  { value: 1, label: 'Company Administrator' },
  { value: 2, label: 'Network Administrator' },
  { value: 3, label: 'Reporter' },
  { value: 5, label: 'Custom' },
] as const

export interface GzAccount {
  id?: string
  accountId?: string
  email?: string
  fullName?: string
  profile?: { fullName?: string; timezone?: string; language?: string }
  role?: number
  authenticationMethod?: number
  targetIds?: string[]
  [key: string]: unknown
}

export interface GzCreateAccountBody {
  email: string
  profile: { fullName: string; timezone?: string; language?: string }
  password?: string
  role?: number
  phoneNumber?: Record<string, unknown>
  rights?: Record<string, unknown>
  targetIds?: string[]
}

export interface GzUpdateAccountBody {
  accountId: string
  email?: string
  authenticationMethod?: number
  password?: string
  role?: number
  fullName?: string
  timezone?: string
  language?: string
  phoneNumber?: Record<string, unknown>
  rights?: Record<string, unknown>
  targetIds?: string[]
}

/** accounts.getAccountsList { page?, perPage? } */
export async function getAccountsList(client: GravityZoneClient, opts: { page?: number; perPage?: number } = {}): Promise<GzAccount[]> {
  const result = await client.call('accounts', 'getAccountsList', opts)
  return unwrapListItems<GzAccount>(result, ['items', 'accounts'])
}

/** accounts.getAccountDetails { accountId? } — omit accountId to read the calling key's own account. */
export async function getAccountDetails(client: GravityZoneClient, accountId: string): Promise<GzAccount | null> {
  try {
    return await client.call<GzAccount>('accounts', 'getAccountDetails', { accountId })
  } catch {
    return null
  }
}

/** accounts.createAccount { email, profile: { fullName, timezone?, language? }, password?, role?, phoneNumber?, rights?, targetIds? } */
export async function createAccount(client: GravityZoneClient, body: GzCreateAccountBody): Promise<{ id: string }> {
  const result = await client.call<Record<string, unknown>>('accounts', 'createAccount', body as unknown as Record<string, unknown>)
  return { id: readId(result, ['id', 'accountId']) }
}

/** accounts.updateAccount { accountId, email?, authenticationMethod?, password?, role?, fullName?, timezone?, language?, phoneNumber?, rights?, targetIds? } */
export async function updateAccount(client: GravityZoneClient, body: GzUpdateAccountBody): Promise<void> {
  await client.call('accounts', 'updateAccount', body as unknown as Record<string, unknown>)
}

/** accounts.deleteAccount { accountId } */
export async function deleteAccount(client: GravityZoneClient, accountId: string): Promise<void> {
  await client.call('accounts', 'deleteAccount', { accountId })
}

// =============================================================================
// Accounts — per-account notification preferences
// https://www.bitdefender.com/business/support/en/77209-126234-getnotificationssettings.html
// https://www.bitdefender.com/business/support/en/77209-125286-configurenotificationssettings.html
// =============================================================================

export interface GzNotificationsSettings {
  deleteAfter?: number
  emailAddresses?: string[]
  includeDeviceFQDN?: boolean
  includeDeviceName?: boolean
  notificationsSettings?: Array<Record<string, unknown>>
  sendOnlyPlainTextEmail?: boolean
  [key: string]: unknown
}

export interface GzConfigureNotificationsBody {
  accountId?: string
  deleteAfter?: number
  emailAddresses?: string[]
  includeDeviceFQDN?: boolean
  includeDeviceName?: boolean
  notificationsSettings?: Array<Record<string, unknown>>
  sendOnlyPlainTextEmail?: boolean
}

/** accounts.getNotificationsSettings { accountId? } — omit accountId to read the calling key's own account. */
export async function getNotificationsSettings(client: GravityZoneClient, accountId?: string): Promise<GzNotificationsSettings> {
  return client.call<GzNotificationsSettings>('accounts', 'getNotificationsSettings', accountId ? { accountId } : {})
}

/** accounts.configureNotificationsSettings { accountId?, deleteAfter?, emailAddresses?, includeDeviceFQDN?, includeDeviceName?, notificationsSettings?, sendOnlyPlainTextEmail? } */
export async function configureNotificationsSettings(client: GravityZoneClient, body: GzConfigureNotificationsBody): Promise<void> {
  await client.call('accounts', 'configureNotificationsSettings', body as unknown as Record<string, unknown>)
}

// =============================================================================
// Companies — the company/tenant profile
// https://www.bitdefender.com/business/support/en/77209-126239-getcompanydetails.html
// https://www.bitdefender.com/business/support/en/77209-126238-updatecompanydetails.html
// =============================================================================

export interface GzCompanyDetails {
  id?: string
  name?: string
  address?: string
  phone?: string
  industry?: number
  country?: string
  state?: string
  enforce2FA?: boolean
  skip2FAPeriod?: number
  contactPerson?: Record<string, unknown>
  mdrContactInformation?: Record<string, unknown>
  [key: string]: unknown
}

export interface GzUpdateCompanyBody {
  companyId?: string
  name?: string
  address?: string
  phone?: string
  industry?: number
  country?: string
  state?: string
  enforce2FA?: boolean
  skip2FAPeriod?: number
  contactPerson?: Record<string, unknown>
  mdrContactInformation?: Record<string, unknown>
}

/** companies.getCompanyDetails { companyId? } — omit companyId to read the company linked to the calling key. */
export async function getCompanyDetails(client: GravityZoneClient, companyId?: string): Promise<GzCompanyDetails> {
  return client.call<GzCompanyDetails>('companies', 'getCompanyDetails', companyId ? { companyId } : {})
}

/** companies.updateCompanyDetails { companyId?, name?, address?, phone?, industry?, country?, state?, enforce2FA?, skip2FAPeriod?, contactPerson?, mdrContactInformation? } */
export async function updateCompanyDetails(client: GravityZoneClient, body: GzUpdateCompanyBody): Promise<void> {
  await client.call('companies', 'updateCompanyDetails', body as unknown as Record<string, unknown>)
}

// =============================================================================
// Network — custom groups (network containers)
// https://www.bitdefender.com/business/support/en/77209-128485-createcustomgroup.html
// https://www.bitdefender.com/business/support/en/77209-128486-deletecustomgroup.html
// https://www.bitdefender.com/business/support/en/77209-128488-getcustomgroupslist.html
//
// (network.moveCustomGroup and network.setEndpointLabel are real, documented,
// write-capable methods this app deliberately does NOT call — see README.md
// "Coverage" for why.)
// =============================================================================

export interface GzCustomGroup {
  id?: string
  groupId?: string
  name?: string
  groupName?: string
  parentId?: string
  [key: string]: unknown
}

/** network.getCustomGroupsList { parentId? } — lists the DIRECT CHILDREN of parentId (top-level Custom Groups container when omitted). */
export async function getCustomGroupsList(client: GravityZoneClient, parentId?: string): Promise<GzCustomGroup[]> {
  const result = await client.call('network', 'getCustomGroupsList', parentId ? { parentId } : {})
  return unwrapListItems<GzCustomGroup>(result, ['items', 'groups'])
}

/** network.createCustomGroup { groupName, parentId? } */
export async function createCustomGroup(client: GravityZoneClient, groupName: string, parentId?: string): Promise<{ id: string }> {
  const result = await client.call<Record<string, unknown>>('network', 'createCustomGroup', parentId ? { groupName, parentId } : { groupName })
  return { id: readId(result, ['id', 'groupId']) }
}

/** network.deleteCustomGroup { groupId, force? } */
export async function deleteCustomGroup(client: GravityZoneClient, groupId: string, force = false): Promise<void> {
  await client.call('network', 'deleteCustomGroup', force ? { groupId, force } : { groupId })
}

// =============================================================================
// Network — policy assignment
// https://www.bitdefender.com/business/support/en/77209-924802-assignpolicy.html
// https://www.bitdefender.com/business/support/en/77209-128489-moveendpoints.html (getManagedEndpointDetails is used for reachability only — see README)
// =============================================================================

export interface GzAssignPolicyBody {
  targetIds: string[]
  policyId?: string
  inheritFromAbove?: boolean
  forcePolicyInheritance?: boolean
}

/** network.assignPolicy { targetIds, policyId?, inheritFromAbove?, forcePolicyInheritance? } */
export async function assignPolicy(client: GravityZoneClient, body: GzAssignPolicyBody): Promise<void> {
  await client.call('network', 'assignPolicy', body as unknown as Record<string, unknown>)
}

export interface GzManagedEndpointDetails {
  id?: string
  name?: string
  fqdn?: string
  [key: string]: unknown
}

/**
 * network.getManagedEndpointDetails { endpointId } — used only as a
 * reachability probe for network-policy-assignments' health check and drift
 * detection (does the target endpoint id still exist?). This app does not
 * treat its response as an authoritative source of "current policy" — see
 * README.md "Known limitations".
 */
export async function getManagedEndpointDetails(client: GravityZoneClient, endpointId: string): Promise<GzManagedEndpointDetails | null> {
  try {
    return await client.call<GzManagedEndpointDetails>('network', 'getManagedEndpointDetails', { endpointId })
  } catch {
    return null
  }
}

// =============================================================================
// Policies — list/read plus the one narrow write: per-module enable/disable
// https://www.bitdefender.com/business/support/en/77209-135303-getpolicieslist.html
// https://www.bitdefender.com/business/support/en/77209-135304-getpolicydetails.html (API version v1.1)
// https://www.bitdefender.com/business/support/en/77209-1385902-setpolicymodulesstate.html
// =============================================================================

export interface GzPolicySummary {
  id?: string
  policyId?: string
  name?: string
  [key: string]: unknown
}

/** policies.getPoliciesList { page?, perPage? } */
export async function getPoliciesList(client: GravityZoneClient, opts: { page?: number; perPage?: number } = {}): Promise<GzPolicySummary[]> {
  const result = await client.call('policies', 'getPoliciesList', opts)
  return unwrapListItems<GzPolicySummary>(result, ['items', 'policies'])
}

/** policies.getPolicyDetails { policyId } — documented at API version v1.1, not the default v1.0. */
export async function getPolicyDetails(client: GravityZoneClient, policyId: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.call<Record<string, unknown>>('policies', 'getPolicyDetails', { policyId }, 'v1.1')
  } catch {
    return null
  }
}

/** policies.setPolicyModulesState { policyId, settings } — `settings` is an opaque per-module enable/disable object; see README.md. */
export async function setPolicyModulesState(client: GravityZoneClient, policyId: string, settings: Record<string, unknown>): Promise<void> {
  await client.call('policies', 'setPolicyModulesState', { policyId, settings })
}

// =============================================================================
// Packages — installation package configuration (not the installer binary)
// https://www.bitdefender.com/business/support/en/77209-135298-createpackage.html
// https://www.bitdefender.com/business/support/en/77209-532512-updatepackage.html
// https://www.bitdefender.com/business/support/en/77209-135300-deletepackage.html
// https://www.bitdefender.com/business/support/en/77209-135299-getpackageslist.html
// https://www.bitdefender.com/business/support/en/77209-135301-getpackagedetails.html
// =============================================================================

export interface GzPackage {
  id?: string
  packageId?: string
  packageName?: string
  name?: string
  description?: string
  language?: string
  productType?: number
  modules?: Record<string, unknown>
  scanMode?: Record<string, unknown>
  settings?: Record<string, unknown>
  roles?: Record<string, unknown>
  deploymentOptions?: Record<string, unknown>
  [key: string]: unknown
}

export interface GzPackageBody {
  packageName: string
  description?: string
  language?: string
  modules?: Record<string, unknown>
  scanMode?: Record<string, unknown>
  settings?: Record<string, unknown>
  roles?: Record<string, unknown>
  deploymentOptions?: Record<string, unknown>
  productType?: number
}

/** packages.getPackagesList { companyId?, page?, perPage? } */
export async function getPackagesList(client: GravityZoneClient, opts: { companyId?: string; page?: number; perPage?: number } = {}): Promise<GzPackage[]> {
  const result = await client.call('packages', 'getPackagesList', opts)
  return unwrapListItems<GzPackage>(result, ['items', 'packages'])
}

/** packages.getPackageDetails { packageId } */
export async function getPackageDetails(client: GravityZoneClient, packageId: string): Promise<GzPackage | null> {
  try {
    return await client.call<GzPackage>('packages', 'getPackageDetails', { packageId })
  } catch {
    return null
  }
}

/** packages.createPackage { packageName, description?, language?, modules?, scanMode?, settings?, roles?, deploymentOptions?, productType? } */
export async function createPackage(client: GravityZoneClient, body: GzPackageBody): Promise<{ id: string }> {
  const result = await client.call<Record<string, unknown>>('packages', 'createPackage', body as unknown as Record<string, unknown>)
  return { id: readId(result, ['id', 'packageId']) }
}

/** packages.updatePackage { packageId, packageName, description?, language?, modules?, scanMode?, settings?, roles?, deploymentOptions?, productType? } */
export async function updatePackage(client: GravityZoneClient, packageId: string, body: GzPackageBody): Promise<void> {
  await client.call('packages', 'updatePackage', { packageId, ...body })
}

/** packages.deletePackage { packageId } */
export async function deletePackage(client: GravityZoneClient, packageId: string): Promise<void> {
  await client.call('packages', 'deletePackage', { packageId })
}

// =============================================================================
// Push — outbound event-notification service configuration (webhook/SIEM push)
// https://www.bitdefender.com/business/support/en/77209-135320-getpusheventsettings.html
// https://www.bitdefender.com/business/support/en/77209-135319-setpusheventsettings.html
// =============================================================================

export const GZ_PUSH_SERVICE_TYPES = ['jsonRPC', 'cef', 'splunk', 'qradar', 'azuresentinel'] as const

export interface GzPushEventSettings {
  status?: number
  serviceType?: string
  serviceSettings?: Record<string, unknown>
  subscribeToEventTypes?: string[]
  [key: string]: unknown
}

export interface GzSetPushEventSettingsBody {
  status: number
  serviceType: string
  serviceSettings: Record<string, unknown>
  subscribeToEventTypes: string[]
}

/** push.getPushEventSettings {} — the tenant-wide push notification configuration; a singleton. */
export async function getPushEventSettings(client: GravityZoneClient): Promise<GzPushEventSettings> {
  return client.call<GzPushEventSettings>('push', 'getPushEventSettings', {})
}

/** push.setPushEventSettings { status, serviceType, serviceSettings, subscribeToEventTypes } — replaces the whole configuration. */
export async function setPushEventSettings(client: GravityZoneClient, body: GzSetPushEventSettingsBody): Promise<void> {
  await client.call('push', 'setPushEventSettings', body as unknown as Record<string, unknown>)
}

// =============================================================================
// Integrations — third-party integration configuration
// https://www.bitdefender.com/business/support/en/77209-1300589-createintegration.html
// https://www.bitdefender.com/business/support/en/77209-1300590-updateintegration.html
// https://www.bitdefender.com/business/support/en/77209-1300625-deleteintegration.html
// https://www.bitdefender.com/business/support/en/77209-1300617-getconfiguredintegrations.html
// https://www.bitdefender.com/business/support/en/77209-1300592-getintegrationdetails.html
// =============================================================================

/** Integration types documented by createIntegration at the time of this app's research; only `1` (VMware) is confirmed. */
export const GZ_INTEGRATION_TYPES = [{ value: 1, label: 'VMware' }] as const

export interface GzIntegration {
  id?: string
  integrationId?: string
  name?: string
  type?: number
  specifics?: Record<string, unknown>
  [key: string]: unknown
}

export interface GzCreateIntegrationBody {
  name: string
  type: number
  specifics: Record<string, unknown>
}

export interface GzUpdateIntegrationBody {
  integrationId: string
  name?: string
  specifics?: Record<string, unknown>
}

/** integrations.getConfiguredIntegrations { companyId?, page?, perPage? } */
export async function getConfiguredIntegrations(client: GravityZoneClient, opts: { companyId?: string; page?: number; perPage?: number } = {}): Promise<GzIntegration[]> {
  const result = await client.call('integrations', 'getConfiguredIntegrations', opts)
  return unwrapListItems<GzIntegration>(result, ['items', 'integrations'])
}

/** integrations.getIntegrationDetails { integrationId } */
export async function getIntegrationDetails(client: GravityZoneClient, integrationId: string): Promise<GzIntegration | null> {
  try {
    return await client.call<GzIntegration>('integrations', 'getIntegrationDetails', { integrationId })
  } catch {
    return null
  }
}

/** integrations.createIntegration { name, type, specifics } */
export async function createIntegration(client: GravityZoneClient, body: GzCreateIntegrationBody): Promise<{ id: string }> {
  const result = await client.call<Record<string, unknown>>('integrations', 'createIntegration', body as unknown as Record<string, unknown>)
  return { id: readId(result, ['id', 'integrationId']) }
}

/** integrations.updateIntegration { integrationId, name?, specifics? } */
export async function updateIntegration(client: GravityZoneClient, body: GzUpdateIntegrationBody): Promise<void> {
  await client.call('integrations', 'updateIntegration', body as unknown as Record<string, unknown>)
}

/** integrations.deleteIntegration { integrationId } */
export async function deleteIntegration(client: GravityZoneClient, integrationId: string): Promise<void> {
  await client.call('integrations', 'deleteIntegration', { integrationId })
}
