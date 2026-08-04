import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  extractAccessReviewSpecs,
  parseArray,
  parseObject,
  type AccessReviewSpec,
  type LiveAccessReview,
} from './validate'
import {
  buildAccessPackageNameToId,
  buildGroupNameToId,
  buildRoleNameToId,
  buildServicePrincipalNameToId,
  buildUserNameToId,
  resolveRef,
  resolveRefs,
} from '../lib/nameMaps'

const BASE = '/identityGovernance/accessReviews/definitions'
const SELECT = '?$select=id,displayName,descriptionForAdmins,scope,instanceEnumerationScope,reviewers,fallbackReviewers,settings'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

interface ScopeNameMaps {
  group: Map<string, string>
  role: Map<string, string>
  accessPackage: Map<string, string>
  servicePrincipal: Map<string, string>
}

async function buildScopeNameMaps(client: GraphClient): Promise<ScopeNameMaps> {
  const [group, role, accessPackage, servicePrincipal] = await Promise.all([
    buildGroupNameToId(client),
    buildRoleNameToId(client),
    buildAccessPackageNameToId(client),
    buildServicePrincipalNameToId(client),
  ])
  return { group, role, accessPackage, servicePrincipal }
}

/**
 * accessReviewQueryScope for reviewing direct + transitive group membership —
 * Microsoft's own "Example 1" (https://learn.microsoft.com/graph/accessreviews-scope-concept).
 */
export function buildGroupMembershipScope(groupId: string): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.accessReviewQueryScope',
    query: `/groups/${groupId}/transitiveMembers`,
    queryType: 'MicrosoftGraph',
  }
}

/**
 * accessReviewQueryScope for reviewing users with an ACTIVE assignment to a
 * directory role — Microsoft's own "Example 12.2"
 * (https://learn.microsoft.com/graph/accessreviews-scope-concept).
 */
export function buildDirectoryRoleScope(roleDefinitionId: string): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.accessReviewQueryScope',
    query: `/roleManagement/directory/roleAssignmentScheduleInstances?$expand=principal&$filter=(assignmentType eq 'Assigned' and isof(principal,'microsoft.graph.user') and roleDefinitionId eq '${roleDefinitionId}')`,
    queryType: 'MicrosoftGraph',
  }
}

/**
 * accessReviewQueryScope for reviewing every assignment of an access
 * package — a single-clause subset of Microsoft's own "Example 10" (which
 * additionally ANDs assignmentPolicyId/catalogId — use the Custom (JSON)
 * scope for that) (https://learn.microsoft.com/graph/accessreviews-scope-concept).
 */
export function buildAccessPackageScope(accessPackageId: string): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.accessReviewQueryScope',
    query: `/identityGovernance/entitlementManagement/accessPackageAssignments?$filter=(accessPackageId eq '${accessPackageId}')`,
    queryType: 'MicrosoftGraph',
  }
}

/**
 * principalResourceMembershipsScope for reviewing every user with direct or
 * transitive access to an application — reproduces Microsoft's own
 * "Example 15" verbatim (the fixed principalScopes pool + the target service
 * principal as the sole resourceScope), including its "/v1.0/" absolute-path
 * query prefix, which Example 15 uses but the plain accessReviewQueryScope
 * examples (1, 10, 12.2 above) do not — this app replicates each example's
 * literal query strings rather than "cleaning up" what looks like an
 * inconsistency across Microsoft's own docs
 * (https://learn.microsoft.com/graph/accessreviews-scope-concept).
 */
export function buildApplicationAccessScope(servicePrincipalId: string): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.principalResourceMembershipsScope',
    principalScopes: [
      { '@odata.type': '#microsoft.graph.accessReviewQueryScope', query: '/v1.0/users', queryType: 'MicrosoftGraph', queryRoot: null },
      {
        '@odata.type': '#microsoft.graph.accessReviewQueryScope',
        query: './members/microsoft.graph.user',
        queryType: 'MicrosoftGraph',
        queryRoot: '/v1.0/groups',
      },
    ],
    resourceScopes: [
      {
        '@odata.type': '#microsoft.graph.accessReviewQueryScope',
        query: `/v1.0/servicePrincipals/${servicePrincipalId}`,
        queryType: 'MicrosoftGraph',
        queryRoot: null,
      },
    ],
  }
}

export interface ResolvedScope {
  scope: Record<string, unknown>
  instanceEnumerationScope?: Record<string, unknown>
}

/** Resolve the spec's scopeType + its picker/JSON field(s) into the Graph scope object(s). */
export function resolveScope(spec: AccessReviewSpec, maps: ScopeNameMaps): { resolved: ResolvedScope | null; missing: string[] } {
  switch (spec.scopeType) {
    case 'groupMembership': {
      const r = resolveRef(spec.scopeGroupId, maps.group)
      if (r.missing) return { resolved: null, missing: [spec.scopeGroupId] }
      return { resolved: { scope: buildGroupMembershipScope(r.id) }, missing: [] }
    }
    case 'directoryRole': {
      const r = resolveRef(spec.scopeRoleDefinitionId, maps.role)
      if (r.missing) return { resolved: null, missing: [spec.scopeRoleDefinitionId] }
      return { resolved: { scope: buildDirectoryRoleScope(r.id) }, missing: [] }
    }
    case 'accessPackageAssignments': {
      const r = resolveRef(spec.scopeAccessPackageId, maps.accessPackage)
      if (r.missing) return { resolved: null, missing: [spec.scopeAccessPackageId] }
      return { resolved: { scope: buildAccessPackageScope(r.id) }, missing: [] }
    }
    case 'applicationAccess': {
      const r = resolveRef(spec.scopeServicePrincipalId, maps.servicePrincipal)
      if (r.missing) return { resolved: null, missing: [spec.scopeServicePrincipalId] }
      return { resolved: { scope: buildApplicationAccessScope(r.id) }, missing: [] }
    }
    case 'custom':
    default: {
      const scope = parseObject(spec.scopeCustomJson)
      if (!scope) return { resolved: null, missing: [] }
      const instanceEnumerationScope = parseObject(spec.instanceEnumerationScopeJson) ?? undefined
      return { resolved: { scope, ...(instanceEnumerationScope ? { instanceEnumerationScope } : {}) }, missing: [] }
    }
  }
}

/** {"query":"/users/{id}","queryType":"MicrosoftGraph"} — Microsoft's "Example 2". */
export function userReviewer(userId: string): Record<string, unknown> {
  return { query: `/users/${userId}`, queryType: 'MicrosoftGraph' }
}

/** {"query":"/groups/{id}/owners","queryType":"MicrosoftGraph"} — Microsoft's "Example 4". */
export function groupOwnersReviewer(groupId: string): Record<string, unknown> {
  return { query: `/groups/${groupId}/owners`, queryType: 'MicrosoftGraph' }
}

/** {"query":"./manager","queryType":"MicrosoftGraph","queryRoot":"decisions"} — Microsoft's "Example 5". */
export const MANAGER_REVIEWER: Record<string, unknown> = { query: './manager', queryType: 'MicrosoftGraph', queryRoot: 'decisions' }

export function buildReviewerScopes(
  userIds: string[],
  groupOwnerIds: string[],
  managersSelfReview: boolean,
  customJson: string
): Record<string, unknown>[] {
  return [
    ...userIds.map(userReviewer),
    ...groupOwnerIds.map(groupOwnersReviewer),
    ...(managersSelfReview ? [MANAGER_REVIEWER] : []),
    ...(parseArray(customJson) ?? []),
  ] as Record<string, unknown>[]
}

export interface ReviewerNameMaps {
  user: Map<string, string>
  group: Map<string, string>
}

export interface ResolvedReviewers {
  reviewers: Record<string, unknown>[]
  fallbackReviewers: Record<string, unknown>[]
}

/**
 * Resolve every reviewer/fallback-reviewer picker field's ids (or hand-typed
 * display names) BEFORE building the /users/{id} and /groups/{id}/owners
 * query strings — an unresolved name must fail loudly rather than silently
 * vanish from the built reviewers array (which would look like "reviewers: []",
 * i.e. a self-review, instead of the missing-target error it actually is).
 */
export function resolveReviewers(
  spec: Pick<
    AccessReviewSpec,
    'reviewerUsers' | 'reviewerGroupOwners' | 'reviewerManagersSelfReview' | 'reviewersCustomJson' |
    'fallbackReviewerUsers' | 'fallbackReviewerGroupOwners' | 'fallbackReviewersCustomJson'
  >,
  maps: ReviewerNameMaps
): { resolved: ResolvedReviewers; missing: string[] } {
  const reviewerUsers = resolveRefs(spec.reviewerUsers, maps.user)
  const reviewerGroups = resolveRefs(spec.reviewerGroupOwners, maps.group)
  const fallbackUsers = resolveRefs(spec.fallbackReviewerUsers, maps.user)
  const fallbackGroups = resolveRefs(spec.fallbackReviewerGroupOwners, maps.group)
  return {
    resolved: {
      reviewers: buildReviewerScopes(reviewerUsers.ids, reviewerGroups.ids, spec.reviewerManagersSelfReview, spec.reviewersCustomJson),
      fallbackReviewers: buildReviewerScopes(fallbackUsers.ids, fallbackGroups.ids, false, spec.fallbackReviewersCustomJson),
    },
    missing: [...reviewerUsers.missing, ...reviewerGroups.missing, ...fallbackUsers.missing, ...fallbackGroups.missing],
  }
}

export function buildBody(spec: AccessReviewSpec, resolvedScope: ResolvedScope, resolvedReviewers: ResolvedReviewers): Record<string, unknown> {
  return {
    displayName: spec.name,
    descriptionForAdmins: spec.descriptionForAdmins || '',
    scope: resolvedScope.scope,
    ...(resolvedScope.instanceEnumerationScope ? { instanceEnumerationScope: resolvedScope.instanceEnumerationScope } : {}),
    reviewers: resolvedReviewers.reviewers,
    fallbackReviewers: resolvedReviewers.fallbackReviewers,
    settings: parseObject(spec.settings) ?? {},
  }
}

function snapshotLive(live: LiveAccessReview): Record<string, unknown> {
  return {
    displayName: live.displayName,
    descriptionForAdmins: live.descriptionForAdmins ?? '',
    scope: live.scope ?? {},
    instanceEnumerationScope: live.instanceEnumerationScope ?? null,
    reviewers: live.reviewers ?? [],
    fallbackReviewers: live.fallbackReviewers ?? [],
    settings: live.settings ?? {},
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractAccessReviewSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAccessReview>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list access reviews: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAccessReview>()
  const liveById = new Map<string, LiveAccessReview>()
  for (const d of listed.items) {
    if (d.displayName) liveByName.set(d.displayName.toLowerCase(), d)
    if (d.id) liveById.set(d.id, d)
  }

  const scopeMaps = await buildScopeNameMaps(client)
  const userNameToId = await buildUserNameToId(client)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  const reviewerMaps: ReviewerNameMaps = { user: userNameToId, group: scopeMaps.group }

  for (const spec of specs) {
    const { resolved, missing } = resolveScope(spec, scopeMaps)
    if (!resolved) {
      const reason = missing.length
        ? `unknown scope target(s) ${missing.join(', ')} — create/verify them first or fix the name`
        : 'Custom Scope (JSON) is missing or invalid'
      failures.push(`${spec.name}: ${reason}`)
      continue
    }

    const { resolved: resolvedReviewers, missing: missingReviewers } = resolveReviewers(spec, reviewerMaps)
    if (missingReviewers.length) {
      failures.push(`${spec.name}: unknown reviewer target(s) ${missingReviewers.join(', ')} — create/verify them first or fix the name`)
      continue
    }

    const body = buildBody(spec, resolved, resolvedReviewers)

    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAccessReview>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some access reviews failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} access review definition(s)`, rollbackData: { entries } }
}
