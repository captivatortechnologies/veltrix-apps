import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { policyAction } from '../../lib/policyAdapter'
import { DEVICE_CONTROL_ENDPOINTS, DEVICE_CONTROL_ENTITY_V1 } from './validate'
import { type DeviceControlRollbackEntry } from './deploy'

/**
 * Roll back device control policies using the state captured during deploy:
 *   - policies that were created are disabled then deleted (enabled policies
 *     cannot be deleted directly; DELETE has no v2, so it targets the v1 entity)
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

  const previousState = (ctx.rollbackData as { previousState?: DeviceControlRollbackEntry[] })
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
            await policyAction(client, DEVICE_CONTROL_ENDPOINTS, entry.id, 'disable')
          } catch {
            // Best effort — the policy may already be disabled or missing.
          }
          const res = await client.request('DELETE', DEVICE_CONTROL_ENTITY_V1, {
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
        if (entry.prior.settings) restore.settings = entry.prior.settings

        const res = await client.request('PATCH', DEVICE_CONTROL_ENDPOINTS.entity, {
          body: { resources: [restore] },
        })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore policy "${entry.name}": ${restoreFailure}`)
        }

        if (entry.prior.enabled !== undefined) {
          await policyAction(
            client,
            DEVICE_CONTROL_ENDPOINTS,
            entry.id,
            entry.prior.enabled ? 'enable' : 'disable',
          )
        }

        // Reverse exactly the assignment changes the deployment recorded.
        for (const groupId of entry.prior.groupsAdded ?? []) {
          await policyAction(client, DEVICE_CONTROL_ENDPOINTS, entry.id, 'remove-host-group', groupId)
        }
        for (const groupId of entry.prior.groupsRemoved ?? []) {
          await policyAction(client, DEVICE_CONTROL_ENDPOINTS, entry.id, 'add-host-group', groupId)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} device control policy(ies): ${reverted.join(', ')}`,
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
