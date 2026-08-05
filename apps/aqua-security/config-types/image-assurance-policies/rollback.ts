import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaAssurancePolicy } from '../../lib/aquasec'
import type { RollbackEntry } from '../lib/common'

const ASSURANCE_TYPE = 'image' as const

/**
 * Undo an image-assurance-policies deploy from rollbackData.previous (written
 * by deploy()). Per entry, reverse the action taken:
 *   created → DELETE the policy we added
 *   updated → PUT the prior policy body back (restore)
 *   deleted → POST the prior policy body to re-create it
 *   noop    → nothing to undo
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry<AquaAssurancePolicy>[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
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
          await client.deleteAssurancePolicy(ASSURANCE_TYPE, entry.name)
          removed++
          break
        case 'updated':
          if (entry.prior) {
            await client.updateAssurancePolicy(ASSURANCE_TYPE, entry.prior)
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            await client.createAssurancePolicy(ASSURANCE_TYPE, entry.prior)
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
      message: `Rolled back image assurance policies: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
