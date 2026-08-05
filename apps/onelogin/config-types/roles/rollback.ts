import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { setRoleApps, type RoleRollbackEntry } from './deploy'

/**
 * Roll back roles using the state captured during deploy:
 *   - roles that were created are deleted (DELETE /api/2/roles/{id}, tolerate 404)
 *   - roles that were updated have their app assignment restored (PUT
 *     /api/2/roles/{id}/apps with the prior full app-id list)
 *
 * Never touches a role this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/api/2/roles/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete role "${entry.name}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.priorAppIds) {
        await setRoleApps(client, entry.id, entry.priorAppIds, entry.name)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} role(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
