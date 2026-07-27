import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import {
  SAVED_QUERY_DELETE_ENDPOINTS,
  SAVED_QUERY_ENDPOINTS,
  type SavedQueryRollbackEntry,
} from './deploy'

/**
 * Roll back NG-SIEM saved queries using the state captured during deploy:
 *   - queries that were created are deleted (via the non-template collection)
 *   - queries that were updated are patched back to their prior values
 *
 * Created queries are re-resolved by name before deletion so a concurrent
 * delete makes rollback a no-op instead of a hard error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SavedQueryRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this query — remove it.
        const live = await findEntityByIdentity(client, SAVED_QUERY_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, SAVED_QUERY_DELETE_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this query — restore the captured prior values. Fields
        // whose prior value was unset get explicit empty values so a
        // description/time range the deployment added is actually removed.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          description: entry.prior.description ?? '',
          time_range: entry.prior.time_range ?? '',
        }
        if (typeof entry.prior.query === 'string') restore.query = entry.prior.query
        if (typeof entry.prior.shared === 'boolean') restore.shared = entry.prior.shared

        await updateEntity(client, SAVED_QUERY_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} NG-SIEM saved query(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} query(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
