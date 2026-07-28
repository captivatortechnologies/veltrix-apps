import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { getLiveRoles } from './deploy'
import { bindingLabel, extractRoleMappingSpecs, partitionRoles } from './validate'

/**
 * Detect drift between the deployed MSSP role mappings and the live tenant
 * state. For each declared binding, the live role-id set is diffed against the
 * declared set. Because the grant is additive, EXTRA live roles are a real
 * finding (an over-permissioned binding), not just missing ones — so any
 * difference in the set is reported, escalated to critical when declared roles
 * are missing. Attribution is best-effort — MSSP roles may not carry a modifier.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractRoleMappingSpecs(ctx.deployedConfig).filter((s) => s.userGroupId && s.cidGroupId)

  for (const spec of specs) {
    const label = bindingLabel(spec.userGroupId, spec.cidGroupId)
    const before = diffs.length
    try {
      const live = await getLiveRoles(client, spec.userGroupId, spec.cidGroupId)
      if (!live.exists) {
        diffs.push({ field: label, expected: 'role mapping present', actual: 'no mapping', severity: 'critical' })
        continue
      }

      const { toAdd: missing, toRevoke: extra } = partitionRoles(spec.roleIds, live.roleIds)
      if (missing.length > 0 || extra.length > 0) {
        diffs.push({
          field: `${label}.roleIds`,
          expected: spec.roleIds.join(', ') || 'none',
          actual: live.roleIds.join(', ') || 'none',
          // Missing declared roles under-provision (critical); extra roles are an
          // additive-grant leftover that over-provisions (warning).
          severity: missing.length > 0 ? 'critical' : 'warning',
        })
      }

      attachDriftActor(diffs.slice(before), live.resource ?? null, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
