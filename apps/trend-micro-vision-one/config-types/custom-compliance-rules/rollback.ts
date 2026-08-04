import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError } from '../../lib/visionOneApi'
import { customRuleItemPath, stripRuleId } from './_shared'
import type { CustomRuleRollbackEntry } from './deploy'

/**
 * Undo a custom-rule deploy from rollbackData.previous (written by deploy()):
 * rules we UPDATED are RESTORED to their prior full body
 * (PATCH beta/cloudPosture/customRules/{id}, with the server-assigned `id`
 * stripped before resending); rules we CREATED are DELETED
 * (DELETE beta/cloudPosture/customRules/{id}). A create whose id could not be
 * resolved (the create response omitted it and the follow-up name lookup found
 * nothing) cannot be targeted for delete and is reported as skipped rather than
 * failing the whole rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: CustomRuleRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-rule rollback' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let removed = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      if (entry.prior?.id) {
        const res = await client.patchBeta(customRuleItemPath(entry.prior.id), stripRuleId(entry.prior))
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback restore failed for "${entry.name}": ${error}` }
        restored++
      } else if (entry.createdId) {
        const res = await client.delBeta(customRuleItemPath(entry.createdId))
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback remove failed for "${entry.name}": ${error}` }
        removed++
      } else {
        skipped++
      }
    }
    const skippedNote =
      skipped > 0 ? `, ${skipped} skipped (rule id could not be resolved after create — remove manually in the console)` : ''
    return {
      success: true,
      message: `Rolled back custom rules: ${restored} restored, ${removed} removed${skippedNote}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
