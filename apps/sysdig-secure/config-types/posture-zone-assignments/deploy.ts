import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPosturePolicySummary, type SysdigZone } from '../../lib/sysdigApi'
import { normalizeBoolean, splitOrderedList } from './_shared'

/**
 * Deploy Sysdig Secure zone posture-policy assignments over the REST API:
 *   zone lookup:   GET    /platform/v1/zones?filter=name:<name>
 *   policy lookup: GET    /api/cspm/v1/policy/policies/list
 *   current:       GET    /api/cspm/v1/zones/<zoneId>/policies
 *   apply:         POST (first) / PUT (subsequent) /api/cspm/v1/zones/<zoneId>/policies
 *   remove:        DELETE /api/cspm/v1/zones/<zoneId>/policies   (for a disabled assignment)
 *
 * Both the zone name and every policy name are HARD dependencies — unlike a
 * runtime policy's Falco rule-name references (tolerated best-effort
 * elsewhere in this app), a compliance zone silently missing a policy the
 * operator declared is a security-relevant surprise, so an unresolved name
 * fails the whole deploy rather than being dropped quietly.
 */
interface RollbackEntry {
  zoneName: string
  zoneId: number
  priorPolicyIds: string[]
  hadAssignment: boolean
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    let policySummaries: SysdigPosturePolicySummary[] | null = null

    for (const item of items) {
      const zoneName = String(item.fields.zoneName ?? '').trim()
      if (!zoneName) continue
      const enabled = normalizeBoolean(item.fields.enabled, true)

      const zoneMatches: SysdigZone[] = await client.findZonesByName(zoneName)
      const zone = zoneMatches.find((z) => String(z.name ?? '').trim() === zoneName)
      if (!zone || typeof zone.id !== 'number') {
        return {
          success: false,
          message: `Applied ${applied.length} zone assignment(s) before failing: no Zone named "${zoneName}" was found.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const currentAssignment = await client.getZonePolicyAssignment(zone.id)
      const priorPolicyIds = currentAssignment?.policyIds ?? []

      if (!enabled) {
        if (priorPolicyIds.length > 0) await client.deleteZonePolicyAssignment(zone.id)
        previous.push({ zoneName, zoneId: zone.id, priorPolicyIds, hadAssignment: priorPolicyIds.length > 0 })
        applied.push(`${zoneName} (cleared)`)
        continue
      }

      if (!policySummaries) policySummaries = await client.listPosturePolicies()
      const policyNames = splitOrderedList(item.fields.policyNames)
      const policyIds: string[] = []
      const missing: string[] = []
      for (const policyName of policyNames) {
        const match = policySummaries.find((p) => String(p.name ?? '').trim() === policyName)
        if (match) policyIds.push(match.id)
        else missing.push(policyName)
      }
      if (missing.length > 0) {
        return {
          success: false,
          message: `Applied ${applied.length} zone assignment(s) before failing: zone "${zoneName}" references unknown Posture Policy name(s): ${missing.join(', ')}.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      if (currentAssignment) await client.updateZonePolicyAssignment(zone.id, policyIds)
      else await client.createZonePolicyAssignment(zone.id, policyIds)
      previous.push({ zoneName, zoneId: zone.id, priorPolicyIds, hadAssignment: priorPolicyIds.length > 0 })
      applied.push(zoneName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} zone assignment(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Zone assignment deploy failed after ${applied.length} zone(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
