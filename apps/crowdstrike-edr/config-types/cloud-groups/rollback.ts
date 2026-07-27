import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import { CLOUD_GROUP_ENDPOINTS, type CloudGroupRollbackEntry } from './deploy'

/**
 * Roll back cloud groups using the state captured during deploy:
 *   - groups that were created are deleted
 *   - groups that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CloudGroupRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, CLOUD_GROUP_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, CLOUD_GROUP_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — restore the captured prior values. Fields
        // whose prior value was unset get explicit empty values so metadata or
        // scope the deployment added is actually removed.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          description: entry.prior.description ?? '',
          owners: entry.prior.owners ?? [],
          selectors: entry.prior.selectors ?? {},
        }
        if (entry.prior.business_impact) restore.business_impact = entry.prior.business_impact
        if (entry.prior.environment) restore.environment = entry.prior.environment
        restore.business_unit = entry.prior.business_unit ?? ''

        await updateEntity(client, CLOUD_GROUP_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} cloud group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
