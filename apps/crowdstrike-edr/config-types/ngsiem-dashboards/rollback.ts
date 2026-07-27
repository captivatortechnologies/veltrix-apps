import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import {
  DASHBOARD_DELETE_ENDPOINTS,
  DASHBOARD_ENDPOINTS,
  type DashboardRollbackEntry,
} from './deploy'

/**
 * Roll back NG-SIEM dashboards using the state captured during deploy:
 *   - dashboards that were created are deleted (via the non-template collection)
 *   - dashboards that were updated are patched back to their prior values
 *
 * Created dashboards are re-resolved by name before deletion so a concurrent
 * delete makes rollback a no-op instead of a hard error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DashboardRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this dashboard — remove it.
        const live = await findEntityByIdentity(client, DASHBOARD_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, DASHBOARD_DELETE_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this dashboard — restore the captured prior values.
        // A description the deployment added is removed by restoring an empty
        // string; the definition is restored to its prior object.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.definition !== undefined) restore.definition = entry.prior.definition
        if (typeof entry.prior.shared === 'boolean') restore.shared = entry.prior.shared

        await updateEntity(client, DASHBOARD_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} NG-SIEM dashboard(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} dashboard(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
