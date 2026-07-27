import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { roleAction, type UserRollbackEntry } from './deploy'

/**
 * Roll back user changes using the state captured during deploy:
 *   - users that were created are deleted (which also drops their grants)
 *   - users that were updated have their prior name restored and the exact
 *     role grant/revoke deltas this deployment applied reversed
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this user — remove it. Deleting also removes any role
        // grants. 404 means it was never created (or already gone).
        if (entry.uuid) {
          const res = await client.request('DELETE', '/user-management/entities/users/v1', {
            query: { user_uuid: entry.uuid },
          })
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete user "${entry.email}": ${deleteFailure}`)
          }
        }
      } else if (entry.uuid) {
        // Deploy updated this user — restore the captured prior name.
        if (entry.nameChanged) {
          const res = await client.request('PATCH', '/user-management/entities/users/v1', {
            query: { user_uuid: entry.uuid },
            body: { first_name: entry.priorFirstName ?? '', last_name: entry.priorLastName ?? '' },
          })
          const restoreFailure = falconFailure(res)
          if (restoreFailure) {
            throw new Error(`Failed to restore user "${entry.email}": ${restoreFailure}`)
          }
        }

        // Reverse exactly the role changes the deployment recorded.
        await roleAction(client, entry.uuid, 'revoke', entry.rolesGranted ?? [])
        await roleAction(client, entry.uuid, 'grant', entry.rolesRevoked ?? [])
      }

      reverted.push(entry.email)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Falcon user(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
