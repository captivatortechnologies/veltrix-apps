import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { OPTION_PROFILE_VM_PATH, type OptionProfileRollbackEntry } from './deploy'

/**
 * Roll back VM option profiles using the state captured during deploy:
 *   - profiles that were created are deleted (action=delete)
 *   - profiles that were updated are best-effort restored (action=update) to
 *     their prior title / global / default flags. The export does not return the
 *     detailed scan settings as re-submittable parameters, so those settings are
 *     not restored — created profiles roll back cleanly.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: OptionProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.post(OPTION_PROFILE_VM_PATH, { action: 'delete', id: entry.id })
          const failed = qualysWriteError(res)
          // A 404 / already-deleted profile is not a rollback failure.
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete option profile "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const params: QualysParams = {
          action: 'update',
          id: entry.id,
          title: p.title,
          global: p.global ? 1 : 0,
          default: p.isDefault ? 1 : 0,
        }
        const res = await client.post(OPTION_PROFILE_VM_PATH, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore option profile "${entry.label}": ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} option profile(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
