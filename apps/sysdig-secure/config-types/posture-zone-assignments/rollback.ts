import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'

/**
 * Undo a zone-assignments deploy from rollbackData.previous — restore the
 * prior policyIds list (whole-list PUT), or DELETE the assignment entirely
 * when the zone had none before this deploy.
 */
interface RollbackEntry {
  zoneName: string
  zoneId: number
  priorPolicyIds: string[]
  hadAssignment: boolean
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let cleared = 0

  try {
    for (const entry of previous) {
      if (entry.hadAssignment) {
        await client.updateZonePolicyAssignment(entry.zoneId, entry.priorPolicyIds)
        restored++
      } else {
        await client.deleteZonePolicyAssignment(entry.zoneId)
        cleared++
      }
    }
    return { success: true, message: `Rolled back zone assignments: ${restored} restored, ${cleared} cleared.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
