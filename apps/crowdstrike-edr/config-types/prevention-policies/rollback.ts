import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { policyAction, type PolicyRollbackEntry } from './deploy'

/**
 * Roll back prevention policies using the state captured during deploy:
 *   - policies that were created are disabled then deleted (enabled policies
 *     cannot be deleted directly)
 *   - policies that were updated are patched back to their prior values,
 *     with enablement restored and the deployment's exact host-group
 *     attach/detach deltas reversed
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. Disable first (enabled
        // policies cannot be deleted); 404 on delete means it never finished
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          try {
            await policyAction(client, entry.id, 'disable')
          } catch {
            // Best effort — the policy may already be disabled or missing.
          }
          const res = await client.request('DELETE', '/policy/entities/prevention/v1', {
            query: { ids: entry.id },
          })
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete policy "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore the captured prior values.
        const restore: Record<string, unknown> = {
          id: entry.id,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.settings.length > 0) restore.settings = entry.prior.settings

        const res = await client.request('PATCH', '/policy/entities/prevention/v1', {
          body: { resources: [restore] },
        })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore policy "${entry.name}": ${restoreFailure}`)
        }

        if (entry.prior.enabled !== undefined) {
          await policyAction(client, entry.id, entry.prior.enabled ? 'enable' : 'disable')
        }

        // Reverse exactly the assignment changes the deployment recorded.
        for (const groupId of entry.prior.groupsAdded ?? []) {
          await policyAction(client, entry.id, 'remove-host-group', groupId)
        }
        for (const groupId of entry.prior.groupsRemoved ?? []) {
          await policyAction(client, entry.id, 'add-host-group', groupId)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} prevention policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
