import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { policyIdentityPath } from '../../lib/deployments'
import {
  POLICY_TYPES,
  assignmentKey,
  extractPolicyAssignmentSpecs,
  isPolicyType,
  listIdentityPolicies,
  resolveIdentityOriginIds,
  resolvePolicyIds,
} from './_shared'

export interface AssignmentRollbackEntry {
  itemId?: string
  key: string
  identityName: string
  policyType: string
  policyName: string
  policyId: number | string
  originId: number | string
  /** Whether this identity was already assigned to this policy before THIS
   * deploy — reconcile/rollback only ever touch assignments this app added. */
  existed: boolean
}

async function loadPriorEntries(ctx: DeployContext): Promise<AssignmentRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: AssignmentRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as AssignmentRollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Internal Network Subnet -> DNS/Web policy assignments. Resolves each
 * declared identity name and policy name to Umbrella's opaque ids, checks what
 * is already assigned (so reconcile/rollback only ever touch what this app
 * added), assigns the missing ones, and unassigns entries this app previously
 * added but no longer declares.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicyAssignmentSpecs(ctx.canvas).filter((s) => s.identityName && s.policyName)

  const [identityIds, policyIds] = await Promise.all([
    resolveIdentityOriginIds(client, specs.map((s) => s.identityName)),
    resolvePolicyIds(client, POLICY_TYPES),
  ])

  const failures: string[] = []
  const resolved: Array<{
    itemId?: string
    identityName: string
    policyType: 'dns' | 'web'
    policyName: string
    originId: number | string
    policyId: number | string
  }> = []

  for (const spec of specs) {
    if (!isPolicyType(spec.policyType)) {
      failures.push(`"${spec.identityName}" -> "${spec.policyName}": unrecognized policy type "${spec.policyType}"`)
      continue
    }
    const originId = identityIds.get(spec.identityName.toLowerCase())
    const policyId = policyIds.get(spec.policyType)?.get(spec.policyName.toLowerCase())
    if (originId == null) {
      failures.push(`"${spec.identityName}" -> ${spec.policyType} "${spec.policyName}": internal network subnet "${spec.identityName}" was not found in Umbrella`)
      continue
    }
    if (policyId == null) {
      failures.push(`"${spec.identityName}" -> ${spec.policyType} "${spec.policyName}": ${spec.policyType} policy "${spec.policyName}" was not found in Umbrella`)
      continue
    }
    resolved.push({ itemId: spec.itemId, identityName: spec.identityName, policyType: spec.policyType, policyName: spec.policyName, originId, policyId })
  }

  const existingByOriginId = new Map<string, Set<string>>()
  for (const originId of new Set(resolved.map((r) => String(r.originId)))) {
    const current = await listIdentityPolicies(client, originId)
    existingByOriginId.set(originId, new Set(current.items.map((p) => `${(p.type ?? 'dns').toLowerCase()}:${p.id}`)))
  }

  const prior = await loadPriorEntries(ctx)
  const entries: AssignmentRollbackEntry[] = []

  for (const spec of resolved) {
    const key = assignmentKey(spec)
    const existed = existingByOriginId.get(String(spec.originId))?.has(`${spec.policyType}:${spec.policyId}`) ?? false
    if (!existed) {
      const res = await client.request('PUT', policyIdentityPath(spec.policyId, spec.originId))
      if (!res.ok) {
        failures.push(`assign "${spec.identityName}" to ${spec.policyType} policy "${spec.policyName}": ${umbrellaErrorMessage(res)}`)
        continue
      }
    }
    entries.push({
      itemId: spec.itemId,
      key,
      identityName: spec.identityName,
      policyType: spec.policyType,
      policyName: spec.policyName,
      policyId: spec.policyId,
      originId: spec.originId,
      existed,
    })
  }

  // Reconcile: unassign entries THIS app added previously but no longer declares.
  const declaredKeys = new Set(entries.map((e) => e.key))
  for (const p of prior) {
    if (p.existed || declaredKeys.has(p.key)) continue
    const res = await client.delete(policyIdentityPath(p.policyId, p.originId))
    if (!res.ok && res.status !== 404) {
      failures.push(`unassign "${p.identityName}" from ${p.policyType} policy "${p.policyName}": ${umbrellaErrorMessage(res)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some assignments failed: ${failures.join('; ')}.`, rollbackData: { entries } }
  }
  return {
    success: true,
    message: `Applied ${entries.length} policy assignment(s).`,
    artifacts: { applied: entries.map((e) => `${e.identityName} -> ${e.policyType}:${e.policyName}`) },
    rollbackData: { entries },
  }
}
