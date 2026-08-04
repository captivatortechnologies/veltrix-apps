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
  extractAssignmentPolicySpecs,
  parseArray,
  parseObject,
  type AssignmentPolicySpec,
  type LiveAssignmentPolicy,
} from './validate'
import {
  buildAccessPackageNameToId,
  buildConnectedOrganizationNameToId,
  buildGroupNameToId,
  buildServicePrincipalNameToId,
  buildUserNameToId,
  resolveRefs,
} from '../lib/nameMaps'
import { connectedOrganizationMembers, groupMembers, singleServicePrincipal, singleUser } from '../lib/subjectSet'

const BASE = '/identityGovernance/entitlementManagement/assignmentPolicies'
const SELECT =
  '?$select=id,displayName,description,allowedTargetScope,expiration,specificAllowedTargets,requestorSettings,requestApprovalSettings'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

interface NameMaps {
  accessPackage: Map<string, string>
  user: Map<string, string>
  group: Map<string, string>
  servicePrincipal: Map<string, string>
  connectedOrganization: Map<string, string>
}

async function buildNameMaps(client: GraphClient): Promise<NameMaps> {
  const [accessPackage, user, group, servicePrincipal, connectedOrganization] = await Promise.all([
    buildAccessPackageNameToId(client),
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildServicePrincipalNameToId(client),
    buildConnectedOrganizationNameToId(client),
  ])
  return { accessPackage, user, group, servicePrincipal, connectedOrganization }
}

export interface ResolvedTargets {
  users: string[]
  groups: string[]
  servicePrincipals: string[]
  connectedOrganizations: string[]
}

function resolveKindedTargets(
  spec: Pick<
    AssignmentPolicySpec,
    'specificTargetUsers' | 'specificTargetGroups' | 'specificTargetServicePrincipals' | 'specificTargetConnectedOrganizations'
  >,
  maps: NameMaps
): { resolved: ResolvedTargets; missing: string[] } {
  const users = resolveRefs(spec.specificTargetUsers, maps.user)
  const groups = resolveRefs(spec.specificTargetGroups, maps.group)
  const servicePrincipals = resolveRefs(spec.specificTargetServicePrincipals, maps.servicePrincipal)
  const connectedOrganizations = resolveRefs(spec.specificTargetConnectedOrganizations, maps.connectedOrganization)
  return {
    resolved: { users: users.ids, groups: groups.ids, servicePrincipals: servicePrincipals.ids, connectedOrganizations: connectedOrganizations.ids },
    missing: [...users.missing, ...groups.missing, ...servicePrincipals.missing, ...connectedOrganizations.missing],
  }
}

function resolveOnBehalfRequestors(
  spec: Pick<AssignmentPolicySpec, 'onBehalfRequestorUsers' | 'onBehalfRequestorGroups' | 'onBehalfRequestorServicePrincipals'>,
  maps: NameMaps
): { resolved: { users: string[]; groups: string[]; servicePrincipals: string[] }; missing: string[] } {
  const users = resolveRefs(spec.onBehalfRequestorUsers, maps.user)
  const groups = resolveRefs(spec.onBehalfRequestorGroups, maps.group)
  const servicePrincipals = resolveRefs(spec.onBehalfRequestorServicePrincipals, maps.servicePrincipal)
  return {
    resolved: { users: users.ids, groups: groups.ids, servicePrincipals: servicePrincipals.ids },
    missing: [...users.missing, ...groups.missing, ...servicePrincipals.missing],
  }
}

function resolvePrimaryApprovers(
  spec: Pick<AssignmentPolicySpec, 'primaryApproverUsers' | 'primaryApproverGroups'>,
  maps: NameMaps
): { resolved: { users: string[]; groups: string[] }; missing: string[] } {
  const users = resolveRefs(spec.primaryApproverUsers, maps.user)
  const groups = resolveRefs(spec.primaryApproverGroups, maps.group)
  return { resolved: { users: users.ids, groups: groups.ids }, missing: [...users.missing, ...groups.missing] }
}

/** accessPackageAssignmentRequestorSettings — https://learn.microsoft.com/graph/api/resources/accesspackageassignmentrequestorsettings */
export function buildRequestorSettings(
  spec: AssignmentPolicySpec,
  onBehalf: { users: string[]; groups: string[]; servicePrincipals: string[] }
): Record<string, unknown> {
  return {
    enableTargetsToSelfAddAccess: spec.enableTargetsToSelfAddAccess,
    enableTargetsToSelfUpdateAccess: spec.enableTargetsToSelfUpdateAccess,
    enableTargetsToSelfRemoveAccess: spec.enableTargetsToSelfRemoveAccess,
    allowCustomAssignmentSchedule: spec.allowCustomAssignmentSchedule,
    enableOnBehalfRequestorsToAddAccess: spec.enableOnBehalfRequestorsToAddAccess,
    enableOnBehalfRequestorsToUpdateAccess: spec.enableOnBehalfRequestorsToUpdateAccess,
    enableOnBehalfRequestorsToRemoveAccess: spec.enableOnBehalfRequestorsToRemoveAccess,
    onBehalfRequestors: [
      ...onBehalf.users.map(singleUser),
      ...onBehalf.groups.map(groupMembers),
      ...onBehalf.servicePrincipals.map(singleServicePrincipal),
    ],
  }
}

/**
 * accessPackageAssignmentApprovalSettings —
 * https://learn.microsoft.com/graph/api/resources/accesspackageassignmentapprovalsettings.
 * `approvalStagesOverride` (a full accessPackageApprovalStage[] JSON array),
 * when it parses to a NON-EMPTY array, replaces the single-stage
 * primaryApprover* fields entirely — see canvas.yaml's helpText.
 */
export function buildApprovalSettings(
  spec: AssignmentPolicySpec,
  primaryApprovers: { users: string[]; groups: string[] }
): Record<string, unknown> {
  const override = parseArray(spec.approvalStagesOverride)
  const approvalRequired = spec.isApprovalRequiredForAdd || spec.isApprovalRequiredForUpdate
  let stages: unknown[] = []
  if (override && override.length > 0) {
    stages = override
  } else if (approvalRequired) {
    stages = [
      {
        '@odata.type': '#microsoft.graph.accessPackageApprovalStage',
        isApproverJustificationRequired: false,
        isEscalationEnabled: false,
        primaryApprovers: [...primaryApprovers.users.map(singleUser), ...primaryApprovers.groups.map(groupMembers)],
      },
    ]
  }
  return {
    isApprovalRequiredForAdd: spec.isApprovalRequiredForAdd,
    isApprovalRequiredForUpdate: spec.isApprovalRequiredForUpdate,
    isRequestorJustificationRequired: spec.isRequestorJustificationRequired,
    stages,
  }
}

/** accessPackageAssignmentPolicy.specificAllowedTargets — required whenever allowedTargetScope is a "specific*" value. */
export function buildSpecificAllowedTargets(targets: ResolvedTargets): Record<string, unknown>[] {
  return [
    ...targets.users.map(singleUser),
    ...targets.groups.map(groupMembers),
    ...targets.servicePrincipals.map(singleServicePrincipal),
    ...targets.connectedOrganizations.map(connectedOrganizationMembers),
  ]
}

export interface ResolvedPolicy {
  specificAllowedTargets: Record<string, unknown>[]
  requestorSettings: Record<string, unknown>
  requestApprovalSettings: Record<string, unknown>
}

export function buildPatchBody(spec: AssignmentPolicySpec, resolved: ResolvedPolicy): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || '',
    allowedTargetScope: spec.allowedTargetScope,
    expiration: parseObject(spec.expiration) ?? {},
    specificAllowedTargets: resolved.specificAllowedTargets,
    requestorSettings: resolved.requestorSettings,
    requestApprovalSettings: resolved.requestApprovalSettings,
  }
}

/** POST body — https://learn.microsoft.com/graph/api/resources/accesspackageassignmentpolicy: accessPackage only needs "id". */
export function buildCreateBody(spec: AssignmentPolicySpec, resolved: ResolvedPolicy, accessPackageId: string): Record<string, unknown> {
  return { ...buildPatchBody(spec, resolved), accessPackage: { id: accessPackageId } }
}

function snapshotLive(live: LiveAssignmentPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? '',
    allowedTargetScope: live.allowedTargetScope ?? 'notSpecified',
    expiration: live.expiration ?? {},
    specificAllowedTargets: live.specificAllowedTargets ?? [],
    requestorSettings: live.requestorSettings ?? {},
    requestApprovalSettings: live.requestApprovalSettings ?? {},
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

  const specs = extractAssignmentPolicySpecs(ctx.canvas).filter((s) => s.name && s.accessPackageId)

  const listed = await client.getAll<LiveAssignmentPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list assignment policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAssignmentPolicy>()
  const liveById = new Map<string, LiveAssignmentPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  // Every id-aware field's display-name/id map is built once for the whole deploy.
  const maps = await buildNameMaps(client)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const pkg = resolveRefs([spec.accessPackageId], maps.accessPackage)
    const targets = resolveKindedTargets(spec, maps)
    const onBehalf = resolveOnBehalfRequestors(spec, maps)
    const approvers = resolvePrimaryApprovers(spec, maps)

    const missing = [...pkg.missing, ...targets.missing, ...onBehalf.missing, ...approvers.missing]
    if (missing.length) {
      failures.push(`${spec.name}: unknown target(s) ${missing.join(', ')} — create/verify them first or fix the name`)
      continue
    }
    const accessPackageId = pkg.ids[0]

    const resolved: ResolvedPolicy = {
      specificAllowedTargets: buildSpecificAllowedTargets(targets.resolved),
      requestorSettings: buildRequestorSettings(spec, onBehalf.resolved),
      requestApprovalSettings: buildApprovalSettings(spec, approvers.resolved),
    }

    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec, resolved, accessPackageId))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAssignmentPolicy>(resp.body)
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
    return { success: false, message: `Some assignment policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} assignment policy(ies)`, rollbackData: { entries } }
}
