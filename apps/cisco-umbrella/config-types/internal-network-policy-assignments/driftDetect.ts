import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import {
  POLICY_TYPES,
  extractPolicyAssignmentSpecs,
  isPolicyType,
  listIdentityPolicies,
  resolveIdentityOriginIds,
  resolvePolicyIds,
} from './_shared'

/**
 * Drift for policy assignments: an identity that can no longer be resolved is
 * critical drift; a resolvable identity whose live policy membership (per
 * `GET /deployments/v2/internalnetworks/{originId}/policies`) does not include
 * a declared assignment is also critical drift (the assignment was removed
 * outside Veltrix). Best-effort and read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractPolicyAssignmentSpecs(ctx.deployedConfig).filter((s) => s.identityName && s.policyName)
  const [identityIds, policyIds] = await Promise.all([
    resolveIdentityOriginIds(client, specs.map((s) => s.identityName)),
    resolvePolicyIds(client, POLICY_TYPES),
  ])

  const diffs: DriftResult['diffs'] = []
  const policiesByOriginId = new Map<string, Set<string>>()

  for (const spec of specs) {
    const label = `${spec.identityName} -> ${spec.policyType}:${spec.policyName}`
    if (!isPolicyType(spec.policyType)) {
      diffs.push({ field: label, expected: 'known policy type', actual: spec.policyType, severity: 'critical' })
      continue
    }
    const originId = identityIds.get(spec.identityName.toLowerCase())
    if (originId == null) {
      diffs.push({ field: label, expected: 'identity present', actual: 'internal network subnet not found', severity: 'critical' })
      continue
    }
    const policyId = policyIds.get(spec.policyType)?.get(spec.policyName.toLowerCase())
    if (policyId == null) {
      diffs.push({ field: label, expected: 'policy present', actual: `${spec.policyType} policy not found`, severity: 'critical' })
      continue
    }

    const cacheKey = String(originId)
    let current = policiesByOriginId.get(cacheKey)
    if (!current) {
      const listed = await listIdentityPolicies(client, originId)
      current = new Set(listed.items.map((p) => `${(p.type ?? 'dns').toLowerCase()}:${p.id}`))
      policiesByOriginId.set(cacheKey, current)
    }

    if (!current.has(`${spec.policyType}:${policyId}`)) {
      diffs.push({ field: label, expected: 'assigned', actual: 'not assigned', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
