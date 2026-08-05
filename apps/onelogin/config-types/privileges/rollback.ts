import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { buildPrivilegeBody, getPrivilegeRoleIds, getPrivilegeUserIds, reconcileMembership, type PrivilegeRollbackEntry } from './deploy'

/**
 * Roll back privileges using the state captured during deploy:
 *   - privileges that were created are deleted (DELETE /api/1/privileges/{id}, tolerate 404)
 *   - privileges that were updated are restored (PUT) to their prior
 *     document (name/description/privilege), and role/user assignment is
 *     re-converged to the prior sets via the same diff-reconciliation deploy
 *     uses (add back what was removed, remove what was added)
 *
 * Never touches a privilege this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PrivilegeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/api/1/privileges/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete privilege "${entry.name}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/api/1/privileges/${entry.id}`, { body: buildPrivilegeBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore privilege "${entry.name}": ${oneLoginErrorMessage(res)}`)
        }

        const [currentRoleIds, currentUserIds] = await Promise.all([
          getPrivilegeRoleIds(client, entry.id),
          getPrivilegeUserIds(client, entry.id),
        ])
        await reconcileMembership(client, entry.id, 'roles', currentRoleIds, entry.priorRoleIds ?? [], entry.name)
        await reconcileMembership(client, entry.id, 'users', currentUserIds, entry.priorUserIds ?? [], entry.name)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} privilege(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} privilege(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
