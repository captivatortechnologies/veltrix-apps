import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import type { HostGroupRollbackEntry } from './deploy'

/**
 * Roll back host groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /devices/entities/host-groups/v1)
 *   - groups that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: HostGroupRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it was never
        // created (or already removed), which is the desired state.
        if (entry.id) {
          const res = await client.request('DELETE', '/devices/entities/host-groups/v1', {
            query: { ids: entry.id },
          })
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete host group "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — restore the captured prior values.
        const restore: Record<string, unknown> = { id: entry.id }
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        if (entry.prior.assignment_rule !== undefined) {
          restore.assignment_rule = entry.prior.assignment_rule
        }

        const res = await client.request('PATCH', '/devices/entities/host-groups/v1', {
          body: { resources: [restore] },
        })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore host group "${entry.name}": ${restoreFailure}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} host group(s): ${reverted.join(', ')}`,
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
