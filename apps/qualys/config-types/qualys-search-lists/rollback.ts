import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { SEARCH_LIST_PATH, type SearchListRollbackEntry } from './deploy'

/**
 * Roll back static search lists using the state captured during deploy:
 *   - lists that were created are deleted (action=delete)
 *   - lists that were updated are restored (action=update) to their prior state
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SearchListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.post(SEARCH_LIST_PATH, { action: 'delete', id: entry.id })
          const failed = qualysWriteError(res)
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete search list "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const params: QualysParams = {
          action: 'update',
          id: entry.id,
          title: p.title,
          global: p.global ? 1 : 0,
          comments: p.comments,
        }
        if (p.qids.length > 0) params.qids = p.qids.join(',')
        const res = await client.post(SEARCH_LIST_PATH, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore search list "${entry.label}": ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} search list(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
