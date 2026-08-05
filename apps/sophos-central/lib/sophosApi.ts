// =============================================================================
// Sophos Central resource API — thin, typed wrappers over SophosClient for
// every resource this app manages. Mirrors lib/merakiApi.ts in the sibling
// Cisco Meraki app: one central file of `list`/`create`/`update`/`delete`
// functions per resource, so every config type's deploy/rollback/driftDetect/
// healthCheck shares the exact same request-building and error handling.
//
// Two Sophos Central API families are used, both REGIONAL (resolved via
// Who-Am-I's apiHosts.dataRegion — see lib/sophosCentral.ts):
//   endpoint/v1 — https://developer.sophos.com/docs/endpoint-v1/1/overview
//   common/v1   — https://developer.sophos.com/docs/common-v1/1/overview
//
// Every list endpoint returns Sophos's page envelope ({ pages, items }) and is
// fetched to completion via listAllPages / listAllPagesByKey (see
// sophosCentral.ts) rather than truncated at one page.
// =============================================================================

import {
  chunk,
  listAllPages,
  listAllPagesByKey,
  parseJson,
  sophosErrorMessage,
  type SophosClient,
} from './sophosCentral'

const ENDPOINT_SERVICE = 'endpoint/v1'
const COMMON_SERVICE = 'common/v1'

function ensureOk(res: { ok: boolean; status: number; body: string }, what: string): void {
  if (!res.ok) throw new Error(`${what}: ${sophosErrorMessage(res)}`)
}

// =============================================================================
// Endpoint Policies
// https://developer.sophos.com/docs/endpoint-v1/1/routes/policies/get
// https://developer.sophos.com/docs/endpoint-v1/1/routes/policies/post
// https://developer.sophos.com/docs/endpoint-v1/1/routes/policies/{policyId}/patch
// https://developer.sophos.com/docs/endpoint-v1/1/routes/policies/{policyId}/delete
// =============================================================================

/** Every `type` the POST /policies endpoint documents (verified 2026-08). No `data-loss-prevention` value is exposed by this API — see README Coverage. */
export const SOPHOS_POLICY_TYPES = [
  'threat-protection',
  'peripheral-control',
  'application-control',
  'web-control',
  'agent-updating',
  'windows-firewall',
  'device-encryption',
  'data-collection-and-investigation',
  'endpoint-dns-protection',
  'server-threat-protection',
  'server-peripheral-control',
  'server-application-control',
  'server-web-control',
  'server-lockdown',
  'server-agent-updating',
  'server-windows-firewall',
  'server-file-integrity-monitoring',
  'server-linux-runtime-detection',
  'server-data-collection-and-investigation',
] as const
export type SophosPolicyType = (typeof SOPHOS_POLICY_TYPES)[number]

/**
 * A policy as Sophos returns/accepts it. `appliesTo` and `settings` are
 * loosely typed on purpose — the Endpoint Policy API itself documents them as
 * open objects ("keys have specific names documented here"), so every handler
 * treats them as opaque JSON, passed through as declared.
 */
export interface SophosPolicy {
  id?: string
  name: string
  type: SophosPolicyType | string
  enabled?: boolean
  priority?: number
  disableAt?: string | null
  appliesTo?: Record<string, unknown>
  settings?: Record<string, unknown>
  lockedByManagingAccount?: boolean
}

export async function listPolicies(client: SophosClient): Promise<SophosPolicy[]> {
  return listAllPages<SophosPolicy>(client, ENDPOINT_SERVICE, '/policies')
}

export async function createPolicy(
  client: SophosClient,
  body: Pick<SophosPolicy, 'name' | 'type'> & Partial<Omit<SophosPolicy, 'name' | 'type' | 'id'>>,
): Promise<SophosPolicy> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', '/policies', { body })
  ensureOk(res, `Failed to create policy "${body.name}" (type "${body.type}")`)
  return parseJson<SophosPolicy>(res.body) ?? (body as SophosPolicy)
}

export async function updatePolicy(
  client: SophosClient,
  policyId: string,
  body: Partial<Omit<SophosPolicy, 'id' | 'type'>>,
): Promise<SophosPolicy> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `/policies/${encodeURIComponent(policyId)}`, { body })
  ensureOk(res, `Failed to update policy "${policyId}"`)
  return parseJson<SophosPolicy>(res.body) ?? ({ ...body, id: policyId } as SophosPolicy)
}

export async function deletePolicy(client: SophosClient, policyId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `/policies/${encodeURIComponent(policyId)}`)
  ensureOk(res, `Failed to delete policy "${policyId}"`)
}

// =============================================================================
// Endpoint Groups
// https://developer.sophos.com/docs/endpoint-v1/1/routes/endpoint-groups/get
// https://developer.sophos.com/docs/endpoint-v1/1/routes/endpoint-groups/post
// https://developer.sophos.com/docs/endpoint-v1/1/routes/endpoint-groups/{groupId}/patch
// https://developer.sophos.com/docs/endpoint-v1/1/routes/endpoint-groups/{groupId}/delete
// https://developer.sophos.com/docs/endpoint-v1/1/routes/endpoint-groups/{groupId}/endpoints/{get,post,delete}
// =============================================================================

export type SophosEndpointGroupType = 'computer' | 'server'

export interface SophosEndpointGroup {
  id?: string
  name: string
  description?: string
  type: SophosEndpointGroupType | string
  endpointIds?: string[]
}

/** Max endpoint ids per POST .../endpoints call (documented limit). */
const ADD_ENDPOINTS_CHUNK = 1000
/** Max endpoint ids per DELETE .../endpoints call — the `ids` query parameter caps at 50. */
const REMOVE_ENDPOINTS_CHUNK = 50

export async function listEndpointGroups(client: SophosClient): Promise<SophosEndpointGroup[]> {
  return listAllPages<SophosEndpointGroup>(client, ENDPOINT_SERVICE, '/endpoint-groups')
}

export async function createEndpointGroup(
  client: SophosClient,
  body: Pick<SophosEndpointGroup, 'name' | 'type'> & Partial<Pick<SophosEndpointGroup, 'description' | 'endpointIds'>>,
): Promise<SophosEndpointGroup> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', '/endpoint-groups', { body })
  ensureOk(res, `Failed to create endpoint group "${body.name}"`)
  return parseJson<SophosEndpointGroup>(res.body) ?? (body as SophosEndpointGroup)
}

/** PATCH only accepts name/description — group `type` and membership are managed separately. */
export async function updateEndpointGroup(
  client: SophosClient,
  groupId: string,
  body: Partial<Pick<SophosEndpointGroup, 'name' | 'description'>>,
): Promise<SophosEndpointGroup> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `/endpoint-groups/${encodeURIComponent(groupId)}`, { body })
  ensureOk(res, `Failed to update endpoint group "${groupId}"`)
  return parseJson<SophosEndpointGroup>(res.body) ?? ({ ...body, id: groupId } as SophosEndpointGroup)
}

export async function deleteEndpointGroup(client: SophosClient, groupId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `/endpoint-groups/${encodeURIComponent(groupId)}`)
  ensureOk(res, `Failed to delete endpoint group "${groupId}"`)
}

interface EndpointRef {
  id: string
}

/** The current member endpoint ids of a group (page-by-key pagination). */
export async function listGroupEndpointIds(client: SophosClient, groupId: string): Promise<string[]> {
  const refs = await listAllPagesByKey<EndpointRef>(client, ENDPOINT_SERVICE, `/endpoint-groups/${encodeURIComponent(groupId)}/endpoints`)
  return refs.map((r) => r.id).filter(Boolean)
}

export async function addEndpointsToGroup(client: SophosClient, groupId: string, ids: string[]): Promise<void> {
  for (const batch of chunk(ids, ADD_ENDPOINTS_CHUNK)) {
    if (batch.length === 0) continue
    const res = await client.request(ENDPOINT_SERVICE, 'POST', `/endpoint-groups/${encodeURIComponent(groupId)}/endpoints`, {
      body: { ids: batch },
    })
    ensureOk(res, `Failed to add ${batch.length} endpoint(s) to group "${groupId}"`)
  }
}

export async function removeEndpointsFromGroup(client: SophosClient, groupId: string, ids: string[]): Promise<void> {
  for (const batch of chunk(ids, REMOVE_ENDPOINTS_CHUNK)) {
    if (batch.length === 0) continue
    const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `/endpoint-groups/${encodeURIComponent(groupId)}/endpoints`, {
      query: { ids: batch },
    })
    ensureOk(res, `Failed to remove ${batch.length} endpoint(s) from group "${groupId}"`)
  }
}

// =============================================================================
// Scanning Exclusions
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/exclusions/scanning/{get,post}
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/exclusions/scanning/{exclusionId}/{get,patch,delete}
// =============================================================================

export const SOPHOS_SCANNING_EXCLUSION_TYPES = [
  'path',
  'posixPath',
  'virtualPath',
  'process',
  'web',
  'pua',
  'detectedExploit',
  'amsi',
  'behavioral',
  'journalHashingProcess',
  'journalHashingPath',
] as const
export const SOPHOS_SCAN_MODES = ['onDemand', 'onAccess', 'onDemandAndOnAccess'] as const

export interface SophosScanningExclusion {
  id?: string
  value: string
  type: (typeof SOPHOS_SCANNING_EXCLUSION_TYPES)[number] | string
  scanMode?: (typeof SOPHOS_SCAN_MODES)[number] | string
  comment?: string
  lockedByManagingAccount?: boolean
}

const SCANNING_EXCLUSIONS_PATH = '/settings/exclusions/scanning'

export async function listScanningExclusions(client: SophosClient): Promise<SophosScanningExclusion[]> {
  return listAllPages<SophosScanningExclusion>(client, ENDPOINT_SERVICE, SCANNING_EXCLUSIONS_PATH)
}

export async function createScanningExclusion(
  client: SophosClient,
  body: Pick<SophosScanningExclusion, 'value' | 'type'> & Partial<Pick<SophosScanningExclusion, 'scanMode' | 'comment'>>,
): Promise<SophosScanningExclusion> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', SCANNING_EXCLUSIONS_PATH, { body })
  ensureOk(res, `Failed to create scanning exclusion "${body.value}" (type "${body.type}")`)
  return parseJson<SophosScanningExclusion>(res.body) ?? (body as SophosScanningExclusion)
}

/** `type` is immutable — PATCH only accepts value/scanMode/comment (value is unsupported for behavioral/detectedExploit types). */
export async function updateScanningExclusion(
  client: SophosClient,
  exclusionId: string,
  body: Partial<Pick<SophosScanningExclusion, 'value' | 'scanMode' | 'comment'>>,
): Promise<SophosScanningExclusion> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `${SCANNING_EXCLUSIONS_PATH}/${encodeURIComponent(exclusionId)}`, { body })
  ensureOk(res, `Failed to update scanning exclusion "${exclusionId}"`)
  return parseJson<SophosScanningExclusion>(res.body) ?? ({ ...body, id: exclusionId } as SophosScanningExclusion)
}

export async function deleteScanningExclusion(client: SophosClient, exclusionId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `${SCANNING_EXCLUSIONS_PATH}/${encodeURIComponent(exclusionId)}`)
  ensureOk(res, `Failed to delete scanning exclusion "${exclusionId}"`)
}

// =============================================================================
// Allowed Items (global allow list)
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/allowed-items/{get,post}
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/allowed-items/{allowedItemId}/{get,patch,delete}
// =============================================================================

export const SOPHOS_ALLOWED_ITEM_TYPES = ['path', 'sha256', 'certificateSigner', 'posixPath'] as const

export interface SophosAllowedItemProperties {
  fileName?: string
  path?: string
  sha256?: string
  certificateSigner?: string
}

export interface SophosAllowedItem {
  id?: string
  type: (typeof SOPHOS_ALLOWED_ITEM_TYPES)[number] | string
  properties: SophosAllowedItemProperties
  comment: string
  originPersonId?: string
  originEndpointId?: string
}

const ALLOWED_ITEMS_PATH = '/settings/allowed-items'

export async function listAllowedItems(client: SophosClient): Promise<SophosAllowedItem[]> {
  return listAllPages<SophosAllowedItem>(client, ENDPOINT_SERVICE, ALLOWED_ITEMS_PATH)
}

export async function createAllowedItem(
  client: SophosClient,
  body: Pick<SophosAllowedItem, 'type' | 'properties' | 'comment'> & Partial<Pick<SophosAllowedItem, 'originPersonId' | 'originEndpointId'>>,
): Promise<SophosAllowedItem> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', ALLOWED_ITEMS_PATH, { body })
  ensureOk(res, `Failed to create allowed item (type "${body.type}")`)
  return parseJson<SophosAllowedItem>(res.body) ?? (body as SophosAllowedItem)
}

/** PATCH only accepts `comment` — type/properties are immutable after creation. */
export async function updateAllowedItem(client: SophosClient, allowedItemId: string, comment: string): Promise<SophosAllowedItem> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `${ALLOWED_ITEMS_PATH}/${encodeURIComponent(allowedItemId)}`, {
    body: { comment },
  })
  ensureOk(res, `Failed to update allowed item "${allowedItemId}"`)
  return parseJson<SophosAllowedItem>(res.body) ?? ({ id: allowedItemId, comment } as SophosAllowedItem)
}

export async function deleteAllowedItem(client: SophosClient, allowedItemId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `${ALLOWED_ITEMS_PATH}/${encodeURIComponent(allowedItemId)}`)
  ensureOk(res, `Failed to delete allowed item "${allowedItemId}"`)
}

// =============================================================================
// Blocked Items (global block list — SHA256 only, create/delete but no update)
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/blocked-items/{get,post}
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/blocked-items/{blockedItemId}/{get,delete}
// =============================================================================

export interface SophosBlockedItemProperties {
  fileName?: string
  path?: string
  sha256: string
}

export interface SophosBlockedItem {
  id?: string
  type: 'sha256'
  properties: SophosBlockedItemProperties
  comment: string
}

const BLOCKED_ITEMS_PATH = '/settings/blocked-items'

export async function listBlockedItems(client: SophosClient): Promise<SophosBlockedItem[]> {
  return listAllPages<SophosBlockedItem>(client, ENDPOINT_SERVICE, BLOCKED_ITEMS_PATH)
}

export async function createBlockedItem(
  client: SophosClient,
  body: Pick<SophosBlockedItem, 'properties' | 'comment'>,
): Promise<SophosBlockedItem> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', BLOCKED_ITEMS_PATH, { body: { type: 'sha256', ...body } })
  ensureOk(res, `Failed to create blocked item (sha256 "${body.properties.sha256}")`)
  return parseJson<SophosBlockedItem>(res.body) ?? ({ type: 'sha256', ...body } as SophosBlockedItem)
}

export async function deleteBlockedItem(client: SophosClient, blockedItemId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `${BLOCKED_ITEMS_PATH}/${encodeURIComponent(blockedItemId)}`)
  ensureOk(res, `Failed to delete blocked item "${blockedItemId}"`)
}

// =============================================================================
// Web Control — Local Sites (custom URL -> category classification)
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/web-control/local-sites/{get,post}
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/web-control/local-sites/{localSiteId}/{get,patch,delete}
// =============================================================================

export interface SophosLocalSite {
  id?: string
  categoryId?: number
  tags?: string[]
  url: string
  comment?: string
}

const LOCAL_SITES_PATH = '/settings/web-control/local-sites'

export async function listLocalSites(client: SophosClient): Promise<SophosLocalSite[]> {
  return listAllPages<SophosLocalSite>(client, ENDPOINT_SERVICE, LOCAL_SITES_PATH)
}

export async function createLocalSite(
  client: SophosClient,
  body: Pick<SophosLocalSite, 'url'> & Partial<Pick<SophosLocalSite, 'categoryId' | 'tags' | 'comment'>>,
): Promise<SophosLocalSite> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', LOCAL_SITES_PATH, { body })
  ensureOk(res, `Failed to create local site "${body.url}"`)
  return parseJson<SophosLocalSite>(res.body) ?? (body as SophosLocalSite)
}

export async function updateLocalSite(
  client: SophosClient,
  localSiteId: string,
  body: Partial<Pick<SophosLocalSite, 'categoryId' | 'tags' | 'url' | 'comment'>>,
): Promise<SophosLocalSite> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `${LOCAL_SITES_PATH}/${encodeURIComponent(localSiteId)}`, { body })
  ensureOk(res, `Failed to update local site "${localSiteId}"`)
  return parseJson<SophosLocalSite>(res.body) ?? ({ ...body, id: localSiteId } as SophosLocalSite)
}

export async function deleteLocalSite(client: SophosClient, localSiteId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `${LOCAL_SITES_PATH}/${encodeURIComponent(localSiteId)}`)
  ensureOk(res, `Failed to delete local site "${localSiteId}"`)
}

// =============================================================================
// Exploit Mitigation — custom protected-application exclusions
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/exploit-mitigation/applications/{get,post}
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/exploit-mitigation/applications/{exploitMitigationApplicationId}/{get,patch,delete}
// =============================================================================

export interface SophosExploitMitigationApplication {
  id?: string
  /** Exactly one absolute path per the documented schema (custom applications only). */
  paths: string[]
}

const EXPLOIT_MITIGATION_APPS_PATH = '/settings/exploit-mitigation/applications'

export async function listExploitMitigationApplications(client: SophosClient): Promise<SophosExploitMitigationApplication[]> {
  return listAllPages<SophosExploitMitigationApplication>(client, ENDPOINT_SERVICE, EXPLOIT_MITIGATION_APPS_PATH)
}

export async function createExploitMitigationApplication(client: SophosClient, path: string): Promise<SophosExploitMitigationApplication> {
  const res = await client.request(ENDPOINT_SERVICE, 'POST', EXPLOIT_MITIGATION_APPS_PATH, { body: { paths: [path] } })
  ensureOk(res, `Failed to create exploit mitigation exclusion "${path}"`)
  return parseJson<SophosExploitMitigationApplication>(res.body) ?? { paths: [path] }
}

export async function updateExploitMitigationApplication(
  client: SophosClient,
  applicationId: string,
  path: string,
): Promise<SophosExploitMitigationApplication> {
  const res = await client.request(ENDPOINT_SERVICE, 'PATCH', `${EXPLOIT_MITIGATION_APPS_PATH}/${encodeURIComponent(applicationId)}`, {
    body: { paths: [path] },
  })
  ensureOk(res, `Failed to update exploit mitigation exclusion "${applicationId}"`)
  return parseJson<SophosExploitMitigationApplication>(res.body) ?? { id: applicationId, paths: [path] }
}

export async function deleteExploitMitigationApplication(client: SophosClient, applicationId: string): Promise<void> {
  const res = await client.request(ENDPOINT_SERVICE, 'DELETE', `${EXPLOIT_MITIGATION_APPS_PATH}/${encodeURIComponent(applicationId)}`)
  ensureOk(res, `Failed to delete exploit mitigation exclusion "${applicationId}"`)
}

// =============================================================================
// Custom Roles (RBAC) — Common API
// https://developer.sophos.com/docs/common-v1/1/routes/roles/{get,post}
// https://developer.sophos.com/docs/common-v1/1/routes/roles/{roleId}/{get,patch,delete}
// =============================================================================

export const SOPHOS_ROLE_PRINCIPAL_TYPES = ['user', 'service'] as const

export interface SophosRole {
  id?: string
  name: string
  description?: string
  principalType: (typeof SOPHOS_ROLE_PRINCIPAL_TYPES)[number] | string
  permissionSets: string[]
}

const ROLES_PATH = '/roles'

export async function listRoles(client: SophosClient): Promise<SophosRole[]> {
  return listAllPages<SophosRole>(client, COMMON_SERVICE, ROLES_PATH)
}

export async function createRole(
  client: SophosClient,
  body: Pick<SophosRole, 'name' | 'principalType' | 'permissionSets'> & Partial<Pick<SophosRole, 'description'>>,
): Promise<SophosRole> {
  const res = await client.request(COMMON_SERVICE, 'POST', ROLES_PATH, { body })
  ensureOk(res, `Failed to create role "${body.name}"`)
  return parseJson<SophosRole>(res.body) ?? (body as SophosRole)
}

/** JSON Merge Patch — `principalType` is immutable after creation. */
export async function updateRole(
  client: SophosClient,
  roleId: string,
  body: Partial<Pick<SophosRole, 'name' | 'description' | 'permissionSets'>>,
): Promise<SophosRole> {
  const res = await client.request(COMMON_SERVICE, 'PATCH', `${ROLES_PATH}/${encodeURIComponent(roleId)}`, { body })
  ensureOk(res, `Failed to update role "${roleId}"`)
  return parseJson<SophosRole>(res.body) ?? ({ ...body, id: roleId } as SophosRole)
}

/** Sophos returns 409 if the role is still assigned to an admin — surfaced as a normal error, not force-deleted. */
export async function deleteRole(client: SophosClient, roleId: string): Promise<void> {
  const res = await client.request(COMMON_SERVICE, 'DELETE', `${ROLES_PATH}/${encodeURIComponent(roleId)}`)
  ensureOk(res, `Failed to delete role "${roleId}"`)
}
