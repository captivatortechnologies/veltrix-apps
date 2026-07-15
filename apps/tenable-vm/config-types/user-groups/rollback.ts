import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { UserGroupRollbackEntry } from './deploy'

/**
 * Roll back user groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /groups/{id})
 *   - groups that were updated are restored (PUT /groups/{id}) to their prior name
 *
 * Rollback keys on the stable numeric id captured during deploy, never on the
 * name. Deleting a group removes the group itself but never touches the user
 * accounts that were members of it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.id != null) {
          const res = await client.request('DELETE', `/groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete user group "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior && entry.prior.name !== undefined) {
        // Deploy updated this group — restore the captured prior name.
        const res = await client.request('PUT', `/groups/${entry.id}`, {
          body: { name: entry.prior.name },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore user group "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} user group(s): ${reverted.join(', ')}. Deleting a group does not remove the user accounts that belonged to it.`,
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
