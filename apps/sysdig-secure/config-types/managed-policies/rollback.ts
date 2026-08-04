import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPolicy } from '../../lib/sysdigApi'

/**
 * Undo a managed-policies deploy from rollbackData.previous — PUT the prior
 * full policy body (its pre-deploy tuning) back onto the same id. A managed
 * policy is never created or deleted, so there is only ever this one action.
 */
interface RollbackEntry {
  name: string
  type: string
  policyId: number
  prior: SysdigPolicy
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0

  try {
    for (const entry of previous) {
      await client.updatePolicy(entry.policyId, { ...entry.prior, id: entry.policyId })
      restored++
    }
    return { success: true, message: `Rolled back ${restored} managed policy(ies) to their prior tuning.` }
  } catch (error) {
    return { success: false, message: `Rollback failed after restoring ${restored}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
