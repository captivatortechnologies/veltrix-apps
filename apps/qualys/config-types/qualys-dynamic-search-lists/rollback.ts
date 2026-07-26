import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { DYNAMIC_LIST_PATH, type DynamicListRollbackEntry } from './deploy'

/**
 * Roll back dynamic search lists using the state captured during deploy:
 *   - lists that were created are deleted (action=delete)
 *   - lists that were updated are best-effort restored (action=update) to their
 *     prior title / global flag / comments. The list API does not return the
 *     criteria as re-submittable parameters, so the criteria themselves are not
 *     restored — created lists roll back cleanly.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DynamicListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.post(DYNAMIC_LIST_PATH, { action: 'delete', id: entry.id })
          const failed = qualysWriteError(res)
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete dynamic search list "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const params: QualysParams = {
          action: 'update',
          id: entry.id,
          title: p.title,
          global: p.global ? 1 : 0,
        }
        if (p.comments) params.comments = p.comments
        const res = await client.post(DYNAMIC_LIST_PATH, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore dynamic search list "${entry.label}": ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} dynamic search list(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
