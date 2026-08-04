import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPosturePolicy } from '../../lib/sysdigApi'

/**
 * Undo a posture-policies deploy from rollbackData.previous.
 *   created → DELETE the policy we added
 *   updated → POST the prior policy body back with the same id (restore)
 *   deleted → POST the prior policy body with no id (re-create; a new id is assigned)
 *   noop    → nothing to undo
 */
type PolicyAction2 = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: PolicyAction2
  policyId: string | null
  prior: SysdigPosturePolicy | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let recreated = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      switch (entry.action) {
        case 'created':
          if (entry.policyId) {
            await client.deletePosturePolicyById(entry.policyId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.policyId && entry.prior) {
            await client.createOrUpdatePosturePolicy({ ...entry.prior, id: entry.policyId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, ...body } = entry.prior
            await client.createOrUpdatePosturePolicy(body as SysdigPosturePolicy)
            recreated++
          } else {
            skipped++
          }
          break
        default:
          skipped++
      }
    }

    return {
      success: true,
      message: `Rolled back posture policies: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
